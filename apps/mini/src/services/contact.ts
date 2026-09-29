// 「联系我们」（我的页 → 学习中心下方）：运营在后台配的**二维码 + 客服电话**。
//
// 数据源复用**公开系统配置**（`GET /api/v1/system/settings`，免登录）——
// 不新建表、不新开接口：运营在后台「联系我们」页里改，小程序拉到的就是同一份。
// 落库形态与首页轮播图**完全一致**：`groupKey='contact' / settingKey='info' /
// valueType='JSON' / isPublic=true`（为什么是 JSON 而不是两条 STRING：见 server/prisma/seed.ts 里
// 「联系我们」那一段的说明 —— admin 的 settings schema 不允许存空串，清空会 400）。
//
// ⚠ 服务端对 `valueType='JSON'` 的项做了一次「简化」：它 `JSON.parse` 之后又
//   `JSON.stringify` 回去，所以拿到手的是**字符串**而不是对象
//   （见 server/src/routes/system-settings.ts::coerceValue）。这里必须自己再 parse 一次。
//
// ★ 本模块的契约：**任何失败都返回 null，绝不抛错；返回 null 表示「整块不要渲染」**。
//   三条失败路径都必须走它：接口挂了、运营还没配、值不是合法 JSON。
//   少判一条的后果是「我的」页底部出现一个空卡片，或者一个打不了号的假电话。
import { getPublicSettings } from './account'

export interface ContactInfo {
  /** 二维码图片地址（服务端返回的公开直链）。空串 = 不渲染二维码那一行 */
  qrcode: string
  /** 展示用的客服电话，**保持运营输入的原样**（可能带 - 或空格，如 400-123-4567）。
   *  空串 = 不渲染电话那一行（含「有号码但拨不动」这种情况，见下面 normalize） */
  phone: string
  /** 一键拨打用的号码：只保留数字与开头的 `+`。phone 非空时它必然非空 */
  dial: string
}

const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * 把运营填的电话清洗成可拨号码。
 *
 * ★ 为什么不直接把原样喂给 `makePhoneCall`：运营很可能填 `400-123-4567` 或
 *   `138 0013 8000`（这是给人看的写法）。带分隔符的号码在部分机型/系统上会被
 *   `tel:` 协议截断，表现为「点了拨打、号码少几位或者没反应」—— 而这类问题**只在真机上现形**，
 *   开发者工具里永远是对的。所以在客户端统一清洗。
 */
function toDialable(raw: string): string {
  const plus = raw.startsWith('+') ? '+' : ''
  const digits = raw.replace(/\D/g, '')
  // 太短的（明显不是号码）不给拨打入口，避免「点了没反应」
  return digits.length >= 5 ? plus + digits : ''
}

/** 把后台存的任意值收敛成能安全渲染的联系方式；两者都空 ⇒ null（整块不渲染） */
function normalize(raw: unknown): ContactInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const it = raw as Record<string, unknown>

  // ★ 二维码必须是**完整的 http(s) 地址**才认：小程序是把它直接塞进 <Image src>，
  //   对象键 / 相对路径 / 半截地址都只会渲染成一片空白，且没有任何提示可循
  //   （同 apps/mini/src/services/home.ts 对轮播图地址的处理）。
  const rawQrcode = asText(it.qrcode)
  const qrcode = /^https?:\/\//i.test(rawQrcode) ? rawQrcode : ''

  // ★ 拨不动就不显示这一行（而不是显示一行点了没反应的电话）。
  //   `dial` 为空有两种来源：号码明显不是号码（如运营填了「客服」二字），
  //   或后台那一步的格式校验被绕过。**正常路径下不该出现** —— 后台页在保存前
  //   就按同一个规则（≥5 位数字）卡住了，这里只是客户端侧的兜底。
  const shownPhone = asText(it.phone)
  const dial = toDialable(shownPhone)

  if (!qrcode && !dial) return null
  return { qrcode, phone: dial ? shownPhone : '', dial }
}

/**
 * 拉取「联系我们」配置。**不抛错**：失败一律返回 null（调用方据此整块不渲染）。
 *
 * 调用点（pages/mine/index.tsx）对它还有一条纪律：**单独发、单独吞错，不并进
 * 页面主数据的 Promise.all** —— 它是锦上添花，接口慢不能把整页拖成「加载中…」
 * （与 listTutorialStats 同一处理）。
 */
export async function getContactInfo(): Promise<ContactInfo | null> {
  try {
    const settings = await getPublicSettings()
    const item = settings.groups?.contact?.find((i) => i.key === 'info')
    if (!item) return null
    // 服务端按理给的是字符串；也可能把已是对象的值原样传出，两条都兜住
    const raw = typeof item.value === 'string' ? JSON.parse(item.value) : item.value
    return normalize(raw)
  } catch {
    return null
  }
}
