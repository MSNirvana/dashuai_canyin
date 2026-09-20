/**
 * 输入文本「trim 契约」验证。
 *
 * 背景：`z.string().min(1)` 会让 `"   "`（三个空格）**通过**校验 —— min 数的是长度，
 * 不是「有没有实际内容」。于是库里会存下纯空白的名称/简介/文案，且**没有任何报错**，
 * 表现为菜品列表空白卡片、AI 提示词里出现空段、成片字幕压空白。
 *
 * 这不是假设：本项目里 `creations.ts` 的 `title` 写对了（`.trim().min(1)`），
 * 而 `stores.ts` / `dishes.ts` 的 `name` 漏了 —— 同一个模式靠手抄必然漂移。
 * 所以收敛到 `src/lib/validators.ts` 的三个工厂函数，本脚本同时守住两件事：
 *   ① 三个工厂函数的行为（含 `.trim()` 必须在 `.min()`/`.max()` **之前**执行）
 *   ② 五个路由文件里那些「用户可见 / 会喂给 AI」的文本字段**必须走工厂函数**，不许退回裸 z.string()
 *
 * 用法：npm run input-trim:verify
 * 纯离线（不连数据库、不起服务），可随时跑。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { requiredText, optionalText, nullableText } from '../src/lib/validators.js'

let pass = 0
let fail = 0
function check(ok: boolean, label: string, extra = '') {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}${extra ? `  ${extra}` : ''}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${extra ? `  ${extra}` : ''}`)
  }
}
function section(t: string) {
  console.log(`\n── ${t} ──`)
}

/** 解析结果：成功返回 trim 后的值，失败返回 null */
function val<T>(schema: z.ZodType<T>, input: unknown): T | null {
  const r = schema.safeParse(input)
  return r.success ? r.data : null
}

// ──────────────────────── ① 缺陷复现 ────────────────────────
section('① 复现缺陷：裸 min(1) 拦不住纯空格')

check(
  z.string().min(1).max(128).safeParse('   ').success,
  '复现：z.string().min(1) 让 "   " 通过（这就是本次修的缺陷）',
)
check(!requiredText(128).safeParse('   ').success, 'requiredText 拦住纯空格')
check(!requiredText(128).safeParse('\t\n  ').success, 'requiredText 拦住制表符/换行构成的空白')
check(!requiredText(128).safeParse('').success, 'requiredText 拦住空串')

// ──────────────────────── ② 三个工厂函数的行为 ────────────────────────
section('② requiredText：先 trim 再判空、再判长')

check(val(requiredText(128), ' 宫保鸡丁 ') === '宫保鸡丁', '两边的空格被真的删掉（不只是"判空时忽略"）')
check(val(requiredText(128), '\n 招牌菜\t') === '招牌菜', '换行/制表符也被删掉')
check(val(requiredText(128), '宫保鸡丁') === '宫保鸡丁', '没有多余空格的正常值不受影响')
check(val(requiredText(128), 'x'.repeat(128))?.length === 128, '正好 128 字通过')
check(!requiredText(128).safeParse('x'.repeat(129)).success, '129 字被拒（max 生效）')
check(
  val(requiredText(128), ` ${'x'.repeat(128)} `)?.length === 128,
  '130 字的输入（含前后空格）通过 —— max 在 trim 之后判，比原来更宽容（期望行为）',
)
check(!requiredText(128).safeParse(undefined).success, 'undefined 被拒（必填字段不能不传）')
check(!requiredText(128).safeParse(123).success, '非字符串被拒')

section('③ optionalText：可选，但落库的值必须已 trim')

check(val(optionalText(500), undefined) === undefined, 'undefined 通过（可选字段可以不传）')
check(val(optionalText(500), '  简介  ') === '简介', '正常值被 trim 后落库')
check(
  val(optionalText(500), '   ') === '',
  '纯空白 → 存成空串（可选字段不拒绝，但语义上等于"没填"）',
)
check(
  !optionalText(500).safeParse(null).success,
  'null 被 optionalText 拒（清空字段要用 nullableText，两者不能混用）',
)

section('④ nullableText：null 表示「清空该字段」，这条路不能坏')

check(val(nullableText(500), null) === null, 'null 通过（否则小程序清空人设会失败）')
check(val(nullableText(500), undefined) === undefined, 'undefined 通过')
check(val(nullableText(500), ' 90后老板 ') === '90后老板', '正常值 trim 后落库')
check(val(nullableText(500), '  ') === '', '纯空白 → 空串（等于"清空"，与传 null 等价）')

// ──────────────────────── ⑤ 源码级守护 ────────────────────────
section('⑤ 源码守护：这几个字段不许退回裸 z.string()')

/** 用户可见 / 会喂给 AI 的文本字段 → 必须走工厂函数 */
const GUARDED: Array<{ file: string; fields: string[] }> = [
  // 门店的 `contact`（联系电话）已于 2026-09-18 从整条链路移除，**不要再加回来** ——
  // 数据库列 store.contact 仍在（只留存量数据，不读不写），所以本清单里也不该出现它。
  { file: '../src/routes/stores.ts', fields: ['name', 'category', 'province', 'city', 'district', 'address', 'intro'] },
  { file: '../src/routes/dishes.ts', fields: ['name', 'intro', 'sellingPoints'] },
  // creations 的 `userIdea`（创作页「你想拍什么风格？」）已于 2026-09-20 从整条链路移除，
  // **不要再加回来** —— 数据库列 creation.user_idea 仍在（不读不写），所以本清单里也不该出现它。
  // 它为什么特别危险：那个值会**直接进提示词**，加回来却没有对应的用户输入时，
  // 模板里那一行只会永远渲染成兜底文案（对照 src/ai/prompt-vars.ts 的警告）。
  { file: '../src/routes/creations.ts', fields: ['title', 'copyText'] },
  { file: '../src/routes/persona.ts', fields: ['bossTags', 'activity'] },
  // 昵称是用户可见文本，同样不许退回裸 z.string()；avatarKey 是对象键，**故意**不走工厂函数
  { file: '../src/routes/profile.ts', fields: ['nickname'] },
]
const HELPERS = ['requiredText(', 'optionalText(', 'nullableText(']

/**
 * 只抽出文件里所有 `const X = z.object({ ... })` 声明块的行，再做字段扫描。
 *
 * 为什么不扫全文件：路由处理函数里也有同名的键，例如
 * `creationSvc.createCreation(prisma, id, { title: input.title })` ——
 * 那是**调用服务的入参**，不是校验声明。扫全文件会把它当成"漏改的字段"报假阳性。
 * 这个扫描器很轻（按行统计花括号深度），够用即可：本文件风格下 `})` 一定独占一行。
 *
 * 允许 `export const X = z.object({` 开头：schema 导出给 verify 脚本复用是期望做法
 * （测试拿线上同一份 schema，而不是手抄一遍长度上限）。
 */
function schemaBlockLines(lines: string[]): string[] {
  const out: string[] = []
  let inBlock = false
  let depth = 0
  for (const l of lines) {
    if (!inBlock) {
      if (/^(?:export )?const \w+ = z\.object\(\{$/.test(l)) {
        inBlock = true
        depth = 1
        out.push(l)
      }
      continue
    }
    out.push(l)
    depth += (l.match(/\{/g)?.length ?? 0) - (l.match(/\}/g)?.length ?? 0)
    if (depth <= 0 || /^\}\)/.test(l)) inBlock = false
  }
  return out
}

for (const { file, fields } of GUARDED) {
  const path = fileURLToPath(new URL(file, import.meta.url))
  const declLines = schemaBlockLines(readFileSync(path, 'utf8').split('\n'))
  check(declLines.length > 0, `${file} 解析到 z.object 声明块`, `${declLines.length} 行`)
  for (const field of fields) {
    // ⚠ 要用 filter 而不是 find —— 同一个字段名可能在多个 schema 里各声明一次
    //（如 creations.ts 的 title 在 createInput 与 creationPatch 各有一处），
    // 只看第一处会漏掉另一处漏改。
    const decls = declLines.filter((l) => new RegExp(`^\\s*${field}\\s*:`).test(l))
    if (decls.length === 0) {
      check(false, `${file} 里找到字段 ${field} 的声明`)
      continue
    }
    for (const decl of decls) {
      const usesHelper = HELPERS.some((h) => decl.includes(h))
      check(
        usesHelper && !decl.includes('z.string()'),
        `${file} 的 ${field} 走 validators 工厂函数`,
        decl.trim(),
      )
    }
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) process.exitCode = 1
