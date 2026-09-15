// 对象键（COS key / 本地存储键）安全校验。
//
// 为什么需要单独抽出来（P2-11）：
//   原先的越权校验只有一句前缀匹配：
//       key.startsWith(`uploads/${merchantId}/`)
//   它拦不住 `uploads/1/../../2/xxx.jpg` —— 前缀匹配通过，但路径解析后落到**商户 2 的目录**。
//   而 lib/local-storage.ts 的 localPathForKey() 只做 relative(root, target) 检查，
//   保证的是「不逃出存储根目录」，**不是**「不逃出当前商户的前缀」，
//   所以这类键能通过两层校验，形成本地存储模式下的跨商家读取（前置条件是知道对方完整 key）。
//
//   结论：必须在**入口**（落库前）就把 `..` / 空段这类非法键掐掉，而不是指望下游路径拼接。
//
// 注意：这类键同时用于 COS 与本地存储，所以放在中立模块，不放进 local-storage.ts。

export class InvalidObjectKeyError extends Error {
  readonly code = 'INVALID_OBJECT_KEY'
  constructor(label: string, reason: string) {
    super(`对象键不合法（${label}）：${reason}`)
    this.name = 'InvalidObjectKeyError'
  }
}

/** 各存储实体的键长度上限（与 schema 里 VARCHAR(512) 对齐） */
const MAX_KEY_LENGTH = 512

/**
 * 校验对象键安全。任何一处不满足即抛 InvalidObjectKeyError。
 * 合法示例：`uploads/12/1712345678901_ab12cd.jpg`、`renders/12/task-9/out.mp4`
 */
export function assertSafeObjectKey(key: string, label = 'key'): void {
  if (typeof key !== 'string' || key.length === 0) throw new InvalidObjectKeyError(label, '不能为空')
  if (key.length > MAX_KEY_LENGTH) throw new InvalidObjectKeyError(label, `长度不能超过 ${MAX_KEY_LENGTH}`)
  if (key.startsWith('/')) throw new InvalidObjectKeyError(label, '不能以 / 开头（应为相对键）')
  if (key.includes('\\')) throw new InvalidObjectKeyError(label, '不能包含反斜杠')
  // 控制字符 / NUL 截断：不同存储后端对它们的处理不一致，一律拒绝
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new InvalidObjectKeyError(label, '不能包含控制字符')

  const segments = key.split('/')
  for (const seg of segments) {
    if (seg === '') throw new InvalidObjectKeyError(label, '包含空路径段（连续 / 或以 / 结尾）')
    if (seg === '.' || seg === '..') throw new InvalidObjectKeyError(label, `包含相对路径段 ${seg}`)
  }
  // URL 编码后的 `..` 或 `%2f`：部分后端会解码，等价于穿越
  if (/%2e|%2f|%5c/i.test(key)) throw new InvalidObjectKeyError(label, '包含疑似编码后的路径分隔符')
}

/** 供调用方做布尔判断（不改抛出语义时用） */
export function isSafeObjectKey(key: string): boolean {
  try {
    assertSafeObjectKey(key)
    return true
  } catch {
    return false
  }
}
