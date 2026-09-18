// 出站请求的目标地址安全闸门（SSRF 防护）。
//
// ── 为什么需要（P1-12）────────────────────────────────────────────────────
// 后台可以填 AI 通道的 `baseUrl`，服务端随后就拿着**已保存的 API key** 去 fetch 它
// （`Authorization: Bearer <key>`）。而原来的校验只有 `z.string().min(1).max(512)`：
//   · 填 `http://127.0.0.1:3000/api/v1/...` ⇒ 从服务器内部打自己的接口，
//     某些路由把查询结果带在响应体里，正好被当「AI 返回的文本」存进 ai_call_log；
//   · 填 `http://169.254.169.254/latest/meta-data/...` ⇒ 云厂商元数据服务（可换到实例凭据）；
//   · 填 `http://内网主机/...` ⇒ 内网探测；
//   · 上面任何一种，API key 都会随请求头一起被对方收到 —— 一次配置就能同时丢密钥 + 打通内网。
//   · 302 重定向还能绕过任何「只校验首个 URL」的检查。
//
// ── 四道闸门 ──────────────────────────────────────────────────────────
//   ① 协议：生产只允许 https（http 需显式 `OUTBOUND_ALLOW_INSECURE=true`，仅供本地联调）
//   ② 主机名：拒绝 localhost / *.localhost / *.local / *.internal / 元数据服务名
//   ③ 解析后的 IP：任一 A/AAAA 落在 loopback / 私网 / link-local / 保留段即拒绝
//      （这一步不能只查 IPv4 字面量 —— 域名可以解析到私网地址，即 DNS rebinding）
//   ④ 重定向：一律不允许自动跟随。要跟随就必须逐跳重新过 ①②③，这里直接禁掉，
//      因为没有哪个正经的 LLM 网关需要 302。
//
// ⚠ 这是一道「降低可利用面」的闸门，不是完备的沙箱：DNS 结果有 TTL 缓存，
//   真正的强隔离要靠网络层（egress 策略）。但对本项目这种「运营在后台手填地址」的场景，
//   上面四条已经拦掉了全部现实攻击面。
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class UnsafeOutboundUrlError extends Error {
  readonly code = 'UNSAFE_OUTBOUND_URL'
  constructor(reason: string) {
    super(`出站地址被拒绝：${reason}`)
    this.name = 'UnsafeOutboundUrlError'
  }
}

/** 明确不允许作为出站目标的主机名（设备名 / 本地名 / 云元数据服务的别名） */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
])

/** 允许的协议 */
const ALLOWED_PROTOCOLS = new Set(['https:', 'http:'])

/**
 * IPv4 段判定。逐段整数比较，避免正则漏段。
 * 覆盖：0/8、10/8、100.64/10（CGNAT）、127/8、169.254/16（link-local，元数据服务就在这）、
 *       172.16/12、192.0.0/24、192.0.2/24（TEST-NET）、192.168/16、198.18/15（基准测试）、
 *       198.51.100/24、203.0.113/24、224/4（组播）、240/4（保留，含 255.255.255.255）
 */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return true // 解析不出来就按不安全处理
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const a = nums[0] as number
  const b = nums[1] as number
  const c = nums[2] as number
  if (a === 0) return true
  if (a === 10) return true
  if (a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a === 198 && b === 51 && c === 100) return true
  if (a === 203 && b === 0 && c === 113) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

/**
 * IPv6 段判定。
 * 覆盖：未指定 ::、loopback ::1、ULA fc00::/7、link-local fe80::/10、组播 ff00::/8、
 *       文档段 2001:db8::/32、以及 IPv4-mapped（::ffff:a.b.c.d）与 NAT64（64:ff9b::/96）
 *       —— 后两者要拆出内嵌的 IPv4 再判一次，否则 `::ffff:127.0.0.1` 会轻松绕过。
 */
function isBlockedIpv6(raw: string): boolean {
  // 去掉 zone id（fe80::1%eth0）后统一小写
  const ip = (raw.split('%')[0] ?? '').toLowerCase()

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (mapped) return isBlockedIpv4(mapped[1] as string)
  const nat64 = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
  if (nat64) return isBlockedIpv4(nat64[1] as string)
  // 十六进制形式的 IPv4-mapped：::ffff:7f00:1
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip)
  if (hexMapped) {
    const hi = parseInt(hexMapped[1] as string, 16)
    const lo = parseInt(hexMapped[2] as string, 16)
    return isBlockedIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }
  // NAT64 的十六进制写法（64:ff9b::a00:1 ⇒ 10.0.0.1）：
  // 标准里的 NAT64 前缀后面就是内嵌的 IPv4，不拆出来判等于留了个直通内网的后门。
  const nat64hex = /^64:ff9b::([0-9a-f]{1,4})(?::([0-9a-f]{1,4}))?$/.exec(ip)
  if (nat64hex) {
    const hi = parseInt(nat64hex[1] as string, 16)
    const lo = nat64hex[2] ? parseInt(nat64hex[2], 16) : 0
    return isBlockedIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`)
  }

  if (ip === '::' || ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true
  const head = ip.split(':')[0] ?? ''
  const headVal = head === '' ? 0 : parseInt(head, 16)
  if (!Number.isInteger(headVal)) return true
  // fc00::/7 ⇒ 首段高 7 位是 1111110；fe80::/10 ⇒ 高 10 位是 1111111010
  if ((headVal & 0xfe00) === 0xfc00) return true
  if ((headVal & 0xffc0) === 0xfe80) return true
  if ((headVal & 0xff00) === 0xff00) return true
  if (headVal === 0x2001 && (ip.startsWith('2001:db8:') || ip === '2001:db8::')) return true
  return false
}

/** 任意 IP 字面量（v4 或 v6）是否被禁止 */
export function isBlockedIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) return isBlockedIpv4(ip)
  if (v === 6) return isBlockedIpv6(ip)
  return true // 不是合法 IP，按不安全处理
}

/** 域名白名单（可选）：逗号分隔的后缀，如 `tokenbox.com,aliyuncs.com` */
function hostAllowlist(env: NodeJS.ProcessEnv): string[] {
  return (env.AI_PROVIDER_HOST_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

export interface OutboundPolicy {
  allowInsecureHttp: boolean
  hostAllowlist: string[]
  /** true = 只做语法/字面量检查，不做 DNS 解析（测试用） */
  skipDns?: boolean
}

export function outboundPolicy(env: NodeJS.ProcessEnv = process.env): OutboundPolicy {
  return {
    allowInsecureHttp: env.OUTBOUND_ALLOW_INSECURE === 'true' || env.NODE_ENV !== 'production',
    hostAllowlist: hostAllowlist(env),
  }
}

/**
 * 校验一个出站 URL 是否安全。不满足任一条即抛 `UnsafeOutboundUrlError`。
 * 返回规范化后的 URL（供调用方直接使用，避免校验与使用不是同一个字符串）。
 */
export async function assertSafeOutboundUrl(
  raw: string,
  policy: OutboundPolicy = outboundPolicy(),
): Promise<URL> {
  if (typeof raw !== 'string' || raw.trim() === '') throw new UnsafeOutboundUrlError('地址为空')
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new UnsafeOutboundUrlError('不是合法 URL')
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UnsafeOutboundUrlError(`协议 ${url.protocol} 不被允许（只允许 https，联调可开 http）`)
  }
  if (url.protocol === 'http:' && !policy.allowInsecureHttp) {
    throw new UnsafeOutboundUrlError('生产环境必须使用 https')
  }
  if (url.username || url.password) {
    throw new UnsafeOutboundUrlError('地址中不允许内嵌用户名/密码')
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) throw new UnsafeOutboundUrlError('缺少主机名')
  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new UnsafeOutboundUrlError(`主机名 ${host} 指向本机或内网别名`)
  }

  if (policy.hostAllowlist.length > 0) {
    const ok = policy.hostAllowlist.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
    if (!ok) throw new UnsafeOutboundUrlError(`主机名 ${host} 不在白名单（AI_PROVIDER_HOST_ALLOWLIST）内`)
  }

  // IP 字面量直接判；域名必须解析后逐个地址判（DNS rebinding 的入口就在这里）
  const literal = isIP(host) ? host : host.startsWith('[') ? host.slice(1, -1) : null
  if (literal) {
    if (isBlockedIp(literal)) throw new UnsafeOutboundUrlError(`IP ${literal} 属于本机/私网/保留地址`)
    return url
  }

  if (!policy.skipDns) {
    let addrs: Array<{ address: string }>
    try {
      addrs = await lookup(host, { all: true })
    } catch {
      throw new UnsafeOutboundUrlError(`主机名 ${host} 无法解析`)
    }
    if (addrs.length === 0) throw new UnsafeOutboundUrlError(`主机名 ${host} 无解析结果`)
    for (const a of addrs) {
      if (isBlockedIp(a.address)) {
        throw new UnsafeOutboundUrlError(`主机名 ${host} 解析到 ${a.address}（本机/私网/保留地址）`)
      }
    }
  }

  return url
}

/**
 * 带安全校验的 fetch。
 *
 * 与裸 `fetch` 的两个区别：
 *   1. 请求前先过 `assertSafeOutboundUrl`；
 *   2. `redirect: 'manual'` —— **绝不自动跟随重定向**。一个被公开的 302 就能把
 *      「看起来安全的域名」变成内网地址，且 Authorization 头会跟着走过去。
 *      跟随必须由调用方显式做（本项目没有这种需求，直接判失败）。
 */
export async function safeFetch(
  url: string,
  init: RequestInit,
  opts: { timeoutMs?: number; policy?: OutboundPolicy } = {},
): Promise<Response> {
  const safe = await assertSafeOutboundUrl(url, opts.policy ?? outboundPolicy())
  const res = await fetch(safe.toString(), {
    ...init,
    redirect: 'manual',
    ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
  })
  if (res.status >= 300 && res.status < 400) {
    throw new UnsafeOutboundUrlError(
      `目标返回 ${res.status} 重定向（Location: ${res.headers.get('location') ?? '-'}），已拒绝跟随`,
    )
  }
  return res
}
