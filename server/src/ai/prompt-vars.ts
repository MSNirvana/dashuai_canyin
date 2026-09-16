// 提示词变量契约。
//
// 为什么需要它：模板里的 {{占位符}} 由网关做字符串替换，取不到值时返回空串 ——
// 也就是说后台把 {{dishName}} 写成 {{dishname}} 不会报错，只会让那一段在提示词里
// 渲染成空白，而且这次调用照常扣豆。所以在保存场景时校验：模板里出现的占位符
// 必须落在该场景的白名单里。

/** 文案类场景可用变量（= creation.service.ts::buildVariables 的产出，4 款 + 通用兜底共用） */
const COPY_VARS = [
  'storeName', 'storeIntro', 'category', 'city',
  'dishName', 'dishIntro', 'sellingPoints',
  'persona',
] as const

/** 分镜场景：在文案变量之上，多了文案正文与镜头数/镜头库 */
const STORYBOARD_VARS = [
  ...COPY_VARS,
  'copyText', 'complexity', 'complexityLabel', 'shotCountRule', 'shotLibrary',
] as const

/** 合成增强场景（已建场景、调用方待接入）：目前模板只用到基础变量 + 文案正文 */
const SYNTH_VARS = [...COPY_VARS, 'copyText', 'shotCountRule'] as const

/**
 * 场景 → 可用变量白名单。
 * 表里**没有**的场景不做校验（宽松放行），避免以后新增场景一上线就被拦。
 */
export const SCENE_VARIABLES: Record<string, readonly string[]> = {
  copy_generate: COPY_VARS,
  copy_traffic: COPY_VARS,
  copy_intro: COPY_VARS,
  copy_quality: COPY_VARS,
  copy_recommend: COPY_VARS,
  storyboard_generate: STORYBOARD_VARS,
  script_polish: SYNTH_VARS,
  review_guard: SYNTH_VARS,
  title_overlay: SYNTH_VARS,
  bgm_select: SYNTH_VARS,
  rhythm_detect: SYNTH_VARS,
}

/**
 * 抽出模板里的全部占位符（去重）。
 * 正则必须与网关替换时用的那条一致（`\w+`），否则会出现「网关照替换、这里查不到」的漏网。
 */
export function extractPlaceholders(template: string): string[] {
  const out = new Set<string>()
  for (const m of template.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) out.add(m[1]!)
  return [...out]
}

/** 模板里「白名单之外」的占位符；场景不在表里则返回空数组（= 不校验） */
export function findUnknownPlaceholders(sceneCode: string, template: string): string[] {
  const allowed = SCENE_VARIABLES[sceneCode]
  if (!allowed) return []
  const set = new Set(allowed)
  return extractPlaceholders(template).filter((v) => !set.has(v))
}

/** 供后台保存失败时给出可读提示 */
export function describeUnknownPlaceholders(unknown: string[]): string {
  return unknown.map((v) => `{{${v}}}`).join('、')
}

/**
 * 写法不合法、网关也**不会替换**的「类占位符」：`{{store.intro}}` / `{{dish name}}` / `{{}}`。
 *
 * 为什么单独查一遍：替换用的正则是 `\{\{\s*(\w+)\s*\}\}`，`\w+` 不认点号和空格 ——
 * 这类写法既不会变成空串，也不会被 findUnknownPlaceholders 抓到，而是**原样留在提示词里**，
 * 模型会看到一堆花括号。危害比「静默变空串」小，但同样是后台手抖写错导致的无声故障。
 */
export function findMalformedPlaceholders(template: string): string[] {
  const out = new Set<string>()
  for (const m of template.matchAll(/\{\{[^{}]*\}\}/g)) {
    if (!/^\{\{\s*\w+\s*\}\}$/.test(m[0])) out.add(m[0])
  }
  return [...out]
}

/**
 * 一次给出模板的全部问题（空数组 = 通过）。
 * 保存场景 / 同步模板都用它，保证「后台手填」和「代码里同步」走同一套判据。
 */
export function validateTemplate(sceneCode: string, template: string): string[] {
  const problems: string[] = []
  const unknown = findUnknownPlaceholders(sceneCode, template)
  if (unknown.length) {
    const allowed = (SCENE_VARIABLES[sceneCode] ?? []).map((v) => `{{${v}}}`).join('、')
    problems.push(`含该场景不支持的变量 ${describeUnknownPlaceholders(unknown)}。该场景可用变量：${allowed}`)
  }
  const malformed = findMalformedPlaceholders(template)
  if (malformed.length) {
    problems.push(
      `含写法不正确的占位符 ${malformed.join('、')}（应为 {{变量名}} 形式，否则网关不会替换，会原样出现在提示词里）`,
    )
  }
  return problems
}
