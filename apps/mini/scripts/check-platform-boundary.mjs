#!/usr/bin/env node
// 源码级「跨端边界」校验 —— 把 docs/12-多端架构约定.md 的红线 1 变成机械检查。
//
// 为什么必须有：
//   适配层在**文件**层面隔离（src/platform/impl.<端>.ts）只保证产物不串；
//   但只要有人在页面里写 `if (IS_DOUYIN) {...}`，隔离就名存实亡 ——
//     · 两端行为会越改越分叉，且「只在某一端生效」的路径极难回归；
//     · 平台专属 API / 字样混进另一个端的包，是平台审核的风险点。
//
// 用法：node scripts/check-platform-boundary.mjs
// 退出码：硬性违规 = 1；否则 0（「待迁移清单」只报告、不判失败）。
//
// ★ 关于「待迁移清单」：抽骨架这一步只把**登录**与**支付**两条链路收进了 src/platform/，
//   下面 PENDING 里那些平台专属调用点是有意留下的。它们随各自端能力接入时一并收进去，
//   收完就把对应规则从 HARD 升级 —— 不要让它长期只报告不拦（告警疲劳的教训：
//   跳过型例外必须补专属断言，否则常亮的东西会训练人忽略它）。

import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, sep } from 'node:path'

const SRC = 'src'
const ALLOW_DIRS = [join('src', 'platform')]
const ALLOW_FILES = [join('src', 'config.ts')]
/** 类型声明（.d.ts shim）不是调用点，不进「待迁移清单」 */
const SKIP_PENDING_DIRS = [join('src', 'types')]

/** 硬性违规：平台判断散落到边界之外就判失败。 */
const HARD_RULES = [
  { label: '平台判断常量', re: /\b(IS_DOUYIN|IS_WEAPP|SUPPORT_WX_QUICK_LOGIN)\b/ },
  { label: 'process.env.TARO_ENV', re: /process\.env\.TARO_ENV/ },
]

/** 只报告：仍是「平台专属」的 API / 依赖，待随各端能力接入收进 src/platform/。 */
const PENDING_RULES = [
  { label: 'Taro.login', re: /\bTaro\.login\s*\(/ },
  { label: 'Taro.requestPayment', re: /\bTaro\.requestPayment\s*\(/ },
  { label: 'Taro.chooseMessageFile', re: /\bTaro\.chooseMessageFile\s*\(/ },
  { label: 'Taro.getRecorderManager', re: /\bTaro\.getRecorderManager\s*\(/ },
  { label: 'Taro.authorize', re: /\bTaro\.authorize\s*\(/ },
  { label: 'cos-wx-sdk-v5', re: /cos-wx-sdk-v5/ },
]

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (['.ts', '.tsx'].includes(extname(e.name))) out.push(p)
  }
  return out
}

/** 注释行不算违规：`// 不要写 if (IS_DOUYIN)` 这类说明性文字到处都会有。 */
function isCommentLine(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

function isAllowed(file) {
  return ALLOW_DIRS.some((d) => file.startsWith(d + sep)) || ALLOW_FILES.includes(file)
}

const hard = []
const pending = []

for (const file of walk(SRC)) {
  const allowed = isAllowed(file)
  const skipPending = SKIP_PENDING_DIRS.some((d) => file.startsWith(d + sep))
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return
    const at = `${file}:${i + 1}`
    if (!allowed) {
      for (const r of HARD_RULES) {
        if (r.re.test(line)) hard.push(`${at}  ${r.label}\n      ${line.trim()}`)
      }
    }
    if (!allowed && !skipPending) {
      for (const r of PENDING_RULES) {
        if (r.re.test(line)) pending.push(`${at}  ${r.label}`)
      }
    }
  })
}

console.log(`[跨端边界] 扫描 ${walk(SRC).length} 个源文件（白名单：${ALLOW_DIRS.join(', ')}、${ALLOW_FILES.join(', ')}）`)

if (hard.length) {
  console.log(`\n✗ ${hard.length} 处平台判断写在了边界之外：`)
  for (const h of hard) console.log('    ' + h)
  console.log('\n  修法：页面/组件/hooks 不要判断平台，改调 platform.*（见 src/platform/index.ts）；')
  console.log('        需要「某端没有这个功能」时，用 platform.capabilities（不要用 if 判断端）。')
} else {
  console.log('✓ 平台判断只出现在适配层与 config.ts')
}

if (pending.length) {
  console.log(`\n[待迁移清单] ${pending.length} 处平台专属调用点尚未收进 src/platform/（不判失败）：`)
  for (const p of pending) console.log('    ' + p)
}

if (hard.length) process.exit(1)
