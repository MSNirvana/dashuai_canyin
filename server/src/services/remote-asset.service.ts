// 把第三方返回的「图片地址」取回成本地文件。
//
// 场景：AI 出图接口（`POST /images/generations`）返回的是 `data[0].url`，
//   域名通常和 API 域名**不是同一个**（实测 API 在 tokenbox.you，图在 download.xmimage2.cc.cd）。
//   要把封面存进自己的对象存储，就必须先把这些字节取回来。
//
// ── 为什么用 curl 而不是 Node 的 fetch ────────────────────────────────────
//   1. **本机网络按域名拦**：实测 `download.xmimage2.cc.cd` 在本机直连时
//      TLS ClientHello 阶段就被 RST（同 IP 换 SNI 立刻 200 ⇒ 是域名级的拦截，
//      不是 DNS、不是 Cloudflare 抖动）。Node 的 fetch 走不了 HTTP 代理，
//      这条路无解；curl 一行 `-x` 就能绕过去，本地联调因此能真跑通。
//      ★ 生产机实测**直连可达**（HTTP 404 = 域名通），所以代理不是必需项 ——
//        只在需要时用 `OUTBOUND_HTTPS_PROXY` 配上，不配就走直连。
//   2. 超时 / 重试 / 拿状态码都是 curl 的原生能力，不用自己写退避循环。
//   ⚠ 用 curl **不等于**放弃 SSRF 守卫：这个 URL 来自**第三方接口的响应体**，
//     是彻头彻尾的外部输入。所以照样先过 `assertSafeOutboundUrl`
//     （协议白名单 / 主机名 / 解析后 IP / 拒重定向），再把**校验过的同一个字符串**
//     交给 curl。少这一步就等于给中转站开了一条「指哪打哪」的内网探测通道。
//
// ★ 为什么先落盘再上传，而不是把字节留在内存里：
//   封面实测 1~2MB（1086x1448 PNG）。内存里过一遍当然也行，但对象存储的
//   `uploadFile(localPath, key, contentType)` 本来就是文件接口，
//   而且落盘之后**出问题能直接上机看那个文件**（排查「传上来的是空白图」这类问题
//   需要的正是原文件）。所以统一走临时文件，调用方保证 finally 删除。
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { assertSafeOutboundUrl } from '../lib/outbound-url.js'
import { sniffImage, type ImageKind } from './public-asset.service.js'

const execFileP = promisify(execFile)

/**
 * 单张图片的体积上限。
 *
 * 实测出图 1~2MB；12MB 留了足够余量，同时挡住「中转站返回一个几百 MB 的地址」
 * 把磁盘写满 / 把上传拖死。这个上限**必须在写盘前**生效，所以下面用 curl 的
 * `--max-filesize`（curl 会在超过时直接放弃）而不是下载完再看大小。
 */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024

export class RemoteImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RemoteImageError'
  }
}

/** 出网代理。生产不需要（实测直连可达），本地联调要它绕开域名级拦截。 */
export function outboundProxy(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OUTBOUND_HTTPS_PROXY ?? '').trim()
}

export interface FetchedImage extends ImageKind {
  bytes: number
}

/**
 * 取回图片并写进 `destPath`。
 *
 * `source` 支持两种形态（与 adapters.ts::openaiImage 的返回值一一对应）：
 *   · `https://…`              —— 图床地址，走 curl 下载
 *   · `data:image/png;base64,…` —— 上游只回 b64 时，解码后直接落盘
 *
 * 返回**嗅探出来的真实类型**（不信 Content-Type、不信后缀）：出图接口的 Content-Type
 * 未必可靠，而错的扩展名会一路传到对象存储的元数据上（本项目已踩过：
 * webp/gif 漏配会落到 video/mp4，部分端直接不渲染）。
 */
export async function fetchImageToFile(
  source: string,
  destPath: string,
  opts: { timeoutMs?: number } = {},
): Promise<FetchedImage> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const raw = source.trim()
  if (!raw) throw new RemoteImageError('图片地址为空')

  if (raw.startsWith('data:')) {
    const match = /^data:([^;,]*);base64,(.*)$/s.exec(raw)
    if (!match) throw new RemoteImageError('无法解析 data URI 形式的图片（只支持 base64 编码）')
    const buffer = Buffer.from(match[2] ?? '', 'base64')
    return finishWrite(buffer, destPath)
  }

  // ★ 外部输入 → 必须过闸门。抛出的 UnsafeOutboundUrlError 会在调用方被翻成人话。
  const safe = await assertSafeOutboundUrl(raw)

  const args = [
    '-sS',
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '--retry', '3',
    '--retry-delay', '1',
    '--retry-connrefused',
    '--max-filesize', String(MAX_IMAGE_BYTES),
    ...(outboundProxy() ? ['-x', outboundProxy()] : []),
    '-w', '%{http_code}',
    '-o', destPath,
    safe.toString(),
  ]

  let stdout = ''
  try {
    ;({ stdout } = await execFileP('curl', args, { maxBuffer: 1 << 20 }))
  } catch (e) {
    const err = e as { stderr?: string; message?: string }
    const detail = (err.stderr || err.message || '').trim().slice(0, 300)
    throw new RemoteImageError(`下载封面失败：${detail || 'curl 执行失败'}`)
  }
  const status = Number(stdout.trim().split(/\s+/).pop())
  // curl 的 -w 输出的是**最后一次**响应的状态码；0 表示压根没连上（DNS/TLS/超时）
  if (!Number.isFinite(status) || status === 0) {
    throw new RemoteImageError('下载封面失败：连接图床时中断（本机网络可能按域名拦截了该图床）')
  }
  if (status !== 200) throw new RemoteImageError(`下载封面失败：图床返回 HTTP ${status}`)

  const info = await stat(destPath).catch(() => null)
  if (!info || info.size === 0) throw new RemoteImageError('下载封面失败：图床返回了空文件')
  if (info.size > MAX_IMAGE_BYTES) throw new RemoteImageError(`封面体积 ${info.size} 字节，超过上限`)

  const { readFile } = await import('node:fs/promises')
  return finishWrite(await readFile(destPath), destPath, true)
}

/**
 * 校验魔数 + 落盘。
 * `alreadyOnDisk` 为 true 表示字节已经在目标路径上（curl 直写），此时不重复写。
 */
async function finishWrite(buffer: Buffer, destPath: string, alreadyOnDisk = false): Promise<FetchedImage> {
  if (buffer.length === 0) throw new RemoteImageError('图片内容为空')
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new RemoteImageError(`图片体积 ${buffer.length} 字节，超过上限 ${MAX_IMAGE_BYTES}`)
  }
  const kind = sniffImage(buffer)
  if (!kind) {
    // 最常见的成因：中转站把「模型不存在」之类的错误当 200 回了一个 HTML/JSON。
    // 所以把前几个字节带上（而不是只说「不是图片」），能一眼看出到底是哪种。
    const head = buffer.subarray(0, 24).toString('latin1').replace(/[^\x20-\x7e]/g, '.')
    throw new RemoteImageError(`返回的内容不是图片（开头字节 ${JSON.stringify(head)}）`)
  }
  if (!alreadyOnDisk) await writeFile(destPath, buffer)
  return { ...kind, bytes: buffer.length }
}

/** 建一个本次任务专用的临时目录；调用方必须在 finally 里删掉（见 publish-material.service.ts）。 */
export async function makeTempDir(prefix = 'dashuai-img-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** 删临时目录。删不掉不算失败（系统临时目录会被自己清理），所以只记日志不抛。 */
export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}
