import { userFacingRenderError } from '../src/render/user-errors.js'

const WANT = '云端合成服务暂不可用，请稍后重试，或改用「基础生成」'

const cases: Array<[string, string | null, string]> = [
  // ── 本次新增：额度 / 计费类，不许把英文原文漏给商户 ──
  ['额度类·credits', 'ChatCut submit_export failed: insufficient credits', WANT],
  ['额度类·quota', 'quota exceeded for this workspace', WANT],
  ['额度类·402', 'HTTP 402 Payment Required', WANT],
  ['额度类·billing', 'Billing error: no active plan', WANT],
  ['额度类·中文', '账户余额不足，请充值', WANT],
  // ── 回归：原有的三类必须仍然对 ──
  ['授权类 401', 'ChatCut MCP 401 Unauthorized', WANT],
  ['授权类 invalid_grant', 'invalid_grant: refresh token expired', WANT],
  ['提交类未返回 id', 'ChatCut submit_export 未返回 renderId', '云端合成任务提交失败，请稍后重试，或改用「基础生成」'],
  ['超时类', 'ETIMEDOUT: connect timeout', '云端合成响应超时，请稍后重试'],
  ['配音类', 'TTS 音色不可用', '配音生成失败，请稍后重试，或换一个配音音色'],
  // ── 回归：业务提示要原样保留（不能被新规则吃掉）──
  ['业务提示', '请先为至少一个分镜上传素材', '请先为至少一个分镜上传素材'],
  ['业务提示2', '素材缺少时长信息，无法计价', '素材缺少时长信息，无法计价'],
  // ── 回归：技术指纹必须挡住 ──
  //   注意：不能拿 "ENOENT /Users/..." 当样本 —— 它会先命中一条**更具体**的业务规则
  //   （「分镜素材文件缺失…请重新上传」），那条才是对的。这里要的是一条纯技术噪音、
  //   任何规则都不命中的输入，用来验证**兜底**分支。
  ['技术指纹·兜底', 'TypeError: fetch failed at RemoteSource (/home/ubuntu/app.js:12)', '合成失败，本次预留的积分已自动退回，可稍后重试'],
]

let pass = 0
let fail = 0
for (const [name, input, expect] of cases) {
  const got = userFacingRenderError(input)
  const ok = got === expect
  if (ok) pass += 1
  else fail += 1
  console.log(`${ok ? '✓' : '✗'} ${name}`)
  if (!ok) console.log(`    期望: ${expect}\n    实际: ${got}`)
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
