// 微信消息推送（XML 数据格式）的最小解析器
//
// ── 为什么手写，而不是引一个通用 XML 库 ─────────────────────────────
// `fast-xml-parser` 只是**传递依赖**躺在 node_modules 里（`package.json` 没声明它），
// 靠它等于把一条**资金链路**挂在上游某天换依赖的运气上；而这里要处理的结构极其有限
// （一层嵌套对象 + 若干标量 + CDATA），手写 60 行 + 用真实报文样例做守护，
// 比引一个通用解析器更可控。
//
// ── 使用场景 ─────────────────────────────────────────────────────
// 小程序虚拟支付的**发货推送** `xpay_goods_deliver_notify`：微信可以按「消息推送」
// 后台里配置的**数据格式**（XML / JSON）投递，且要求**响应格式与推送格式一致**。
// 本项目两种都收，解析失败时会**响亮报错并记录原文**，绝不静默当成「无事件」吞掉。
//
// ★ 本文件只做「结构 → 对象」的机械转换，**不含任何业务判据**（事件类型、环境、
//   金额、道具ID 的校验都在 routes/xpay.ts 里）。这样守护脚本能把解析器的边界
//   单独穷举，而不用连带跑一遍业务逻辑。

/** XML 实体反转义。★ `&amp;` 必须**最后**替换，否则 `&amp;lt;` 会被二次解码成 `<`。 */
function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h: string) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => codePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 数值超出 Unicode 范围时 `String.fromCodePoint` 会抛错；这里退化成「原样保留」。 */
function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return ''
  try {
    return String.fromCodePoint(n)
  } catch {
    return ''
  }
}

/**
 * 取一个元素的文本值。
 *
 * ★ CDATA 与普通文本的**反转义规则不同**：CDATA 内部就是字面量（`a<b` 就是 `a<b`），
 *   而普通文本里的 `<` 必然已被转义成 `&lt;`。两者都走一遍反转义会得到错误结果，
 *   所以先判外壳：整段被 CDATA 包住 ⇒ 只脱壳；否则 ⇒ 反转义。
 */
function textOf(raw: string): string {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
  if (cdata) return cdata[1] ?? ''
  return unescapeXml(raw.trim())
}

/** 元素名。用于在闭合标签里精确定位，因此不允许出现空白与斜杠。 */
const NAME_RE = /^[A-Za-z_][\w.:-]*/

/** 把元素名安全地嵌进正则（名字里可能有 `.` 这类元字符）。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 解析一段「元素序列」。
 *
 * 逐层递归下降：读到 `<Name ...>` 就去找**同名**的闭合标签 `</Name>`，
 * 中间那段若还含标签（且不是 CDATA）⇒ 递归成嵌套对象，否则 ⇒ 当作标量文本。
 *
 * ★ **同级出现重复元素名 ⇒ 直接抛错（fail-closed）**。
 *   本解析器靠 `indexOf('</Name>')` 配对，遇到同级同名（`<A>1</A><A>2</A>`）或
 *   同名嵌套（`<A><A>x</A></A>`）会把标签配错，读出一个**看起来正常、实际错位**的值。
 *   对发货推送这种资金链路来说，「静默读错」比「响亮拒绝」危险得多 ——
 *   前者可能用错误的订单号/金额去发货，后者只会让微信重推 + 落一条告警。
 *   微信的推送报文是固定结构（字段名互不重复，见官方字段表），正常不会触发；
 *   真触发了说明报文形状变了，**必须让人看到**。
 */
function parseChildren(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt < 0) break
    const gt = src.indexOf('>', lt)
    if (gt < 0) break // 截断的报文：剩下的部分放弃，不抛错（由调用方判必填字段）
    const head = src.slice(lt + 1, gt).trim()

    // 注释 / 处理指令 / 裸闭合标签：跳过
    if (head === '' || head.startsWith('!') || head.startsWith('?') || head.startsWith('/')) {
      i = gt + 1
      continue
    }

    const selfClosing = head.endsWith('/')
    const name = (head.replace(/\/\s*$/, '').match(NAME_RE) ?? [''])[0]
    if (!name) {
      i = gt + 1
      continue
    }
    if (name in out) throw new Error(`wx-xml: 同级出现重复元素 <${name}>，无法安全配对`)
    if (selfClosing) {
      out[name] = ''
      i = gt + 1
      continue
    }

    const closeTag = `</${name}>`
    const close = src.indexOf(closeTag, gt + 1)
    if (close < 0) break // 没有闭合：视为截断
    const inner = src.slice(gt + 1, close)
    const isCdata = /^\s*<!\[CDATA\[/.test(inner)
    if (!isCdata && inner.includes('<')) {
      // ★ 同名嵌套（`<A><A>x</A></A>`）：`indexOf` 会把 `</A>` 配给**内层**的 `<A>`，
      //   于是 inner 只剩一个孤零零的 `<A>`，递归后得到 `{A:{}}` —— 真正的文本 'x' 被丢掉，
      //   而形状看起来完全正常。资金链路上不能容忍这种静默错读，直接拒绝。
      if (new RegExp(`<${escapeRe(name)}[\\s/>]`).test(inner)) {
        throw new Error(`wx-xml: 同名嵌套元素 <${name}>，无法安全配对`)
      }
      out[name] = parseChildren(inner)
    } else {
      out[name] = textOf(inner)
    }
    i = close + closeTag.length
  }
  return out
}

/**
 * 把微信推送的 XML 报文解析成普通对象。
 *
 * 兼容两种外壳：标准 `<xml>…</xml>`（微信消息推送的固定外壳）与「裸元素序列」。
 * 返回的键名与报文**逐字一致**（`ToUserName` / `GoodsInfo.ProductId` …）。
 */
export function parseWxXml(xml: string): Record<string, unknown> {
  const trimmed = xml.trim()
  // 去掉 `<?xml version="1.0"?>` 声明
  const body = trimmed.replace(/^<\?xml[\s\S]*?\?>\s*/, '')
  const parsed = parseChildren(body)
  // 拆掉 `<xml>` 外壳。★ 只在「整段只有这一个根元素且它是对象」时拆，
  //   否则会把「恰好只有一个字段」的报文也误拆一层。
  if (/^<xml[\s>]/.test(body)) {
    const inner = parsed.xml
    if (inner && typeof inner === 'object') return inner as Record<string, unknown>
  }
  return parsed
}

/** 取字符串字段（去空白）。非字符串/缺失一律返回 ''，调用方自己判必填。 */
export function xmlStr(node: Record<string, unknown>, key: string): string {
  const v = node[key]
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') return ''
  return String(v).trim()
}

/** 取嵌套对象字段（如 `GoodsInfo`）。缺失或不是对象时返回空对象。 */
export function xmlObj(node: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = node[key]
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return {}
}
