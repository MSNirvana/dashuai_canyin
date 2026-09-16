// 短信通道只读自检。
//
// 一眼看清「当前短信通道到底能不能用」：配置是否齐全、签名/模板在腾讯云侧是什么状态、
// 配置里写的签名名字是否与已过审的那条一致。
//
// 为什么需要它：短信链路的失败点比支付更隐蔽 ——
//   腾讯云 `SendSms` **失败也返回 HTTP 200**，配置写错、签名没审过、权限没给，
//   都不会在业务日志里炸出异常，只会「静默不发」。
//   所以排查「用户说收不到短信」时，第一步就该跑它。
//
// 只读：不发短信、不写数据库、无副作用。失败调用也不计费。
// 需要权限：`sms:DescribeSmsSignList` / `sms:DescribeSmsTemplateList`
//   （若子账号只授了 `sms:SendSms`，本节会提示缺权限，属预期）
//
// 跑法：npm run sms:status
import '../src/env.js'
import tencentcloud from 'tencentcloud-sdk-nodejs-sms'
import { smsProviderMode, readTencentSmsConfig, missingTencentSmsKeys } from '../src/auth/sms-provider.js'
import { smsTestCodeConfig } from '../src/auth/sms.js'

/** 脱敏：只露头尾，够核对身份但不泄露完整凭据 */
const mask = (s: string): string => (s ? `${s.slice(0, 8)}…${s.slice(-4)}` : '(空)')

/** 手机号脱敏：138****0001。排查时够定位自己那个号，日志被转发也不泄露全量。 */
const maskPhone = (p: string): string => (p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : '***')

/**
 * 签名状态码 → 人话。
 *
 * ★ 取值口径**照抄 SDK 自带类型注释**（`tencentcloud-sdk-nodejs-sms` 的
 *   `sms_models.d.ts::DescribeSignListStatus.StatusCode`）—— 那是最权威、且离线可查的一手资料：
 *
 *   国内短信：0 可用 / 1 审核中 / 2 审核通过待生效 /
 *            **-1 审核未通过、审核失败 或 未完成首次报备** 等原因导致签名不可用
 *   国际短信：0 审核通过且已生效 / 1 审核中 / 2 审核通过待生效 / -1 未通过或失败
 *
 * ⚠ 踩过的坑（2026-09-16，真实误判）：**-1 一度被本脚本标成「审核未通过」**，
 *   于是看到 -1 就去「重新申请签名」。但 -1 里包含「**未完成首次报备**」这一支 ——
 *   而腾讯云 2025 起要求签名必须完成**运营商实名制报备**才能发送，报备平均 7-10 个工作日。
 *   控制台此时显示「报备中」，恰恰说明**腾讯云平台审核已经通过**。
 *   把它当成"被驳回"去重新申请，等于把正在走的报备流程推倒重来，白等 7-10 天。
 *
 * ⇒ 因此本函数**只陈述"能不能用"，不臆断"为什么不能用"**；原因交给 `explainUnavailable()`。
 */
function verdict(statusCode: number | undefined, international = 0): string {
  if (statusCode === undefined) return '❔ 状态未知'
  if (international === 1) {
    // 国际/港澳台短信走的是另一套口径
    if (statusCode === 0) return '✅ 审核通过且已生效'
    if (statusCode === 1) return '⏳ 审核中'
    if (statusCode === 2) return '⏳ 审核通过待生效'
    if (statusCode === -1) return '⛔ 不可用（审核未通过或审核失败）'
    return `❔ 未知状态码 ${statusCode}`
  }
  if (statusCode === 0) return '✅ 签名可用（审核通过 且 运营商已返回报备成功）'
  if (statusCode === 1) return '⏳ 审核中'
  if (statusCode === 2) return '⏳ 审核通过待生效'
  if (statusCode === -1) return '⛔ 签名不可用'
  return `❔ 未知状态码 ${statusCode}`
}

/**
 * 模板状态码 → 人话。**与签名是两套口径，不能共用 `verdict()`**。
 *
 * SDK 注释（`DescribeTemplateListStatus.StatusCode`）：
 *   0 审核通过且已生效 / 1 审核中 / 2 审核通过待生效 / -1 审核未通过或审核失败。
 *   **只有状态值为 0 时该模板才能使用**。
 * 与签名的差别：模板**没有运营商报备环节** ⇒ 这里的 -1 就是实打实的"没通过"。
 */
function templateVerdict(statusCode: number | undefined): string {
  if (statusCode === undefined) return '❔ 状态未知'
  if (statusCode === 0) return '✅ 审核通过且已生效'
  if (statusCode === 1) return '⏳ 审核中'
  if (statusCode === 2) return '⏳ 审核通过待生效'
  if (statusCode === -1) return '⛔ 审核未通过或审核失败'
  return `❔ 未知状态码 ${statusCode}`
}

/**
 * `-1`（不可用）的原因分析。**绝不臆断成"审核未通过"** —— 官方口径里它至少涵盖三种原因：
 *   ① 未通过腾讯云平台审核　② 首次提交运营商报备失败　③ **未完成首次报备（报备中）**
 *
 * 判据只有一条但很硬：**`ReviewReply` 非空 ⇒ 确实是审核被驳回**（有具体理由）；
 * **为空 ⇒ 不能断定**，很可能是还在报备中。真正的原因在控制台的「报备状态」列。
 */
function explainUnavailable(reviewReply: string | undefined): string[] {
  const lines: string[] = []
  if (reviewReply) {
    lines.push(`      审核理由：${(reviewReply.split('\n')[0] ?? '').slice(0, 100)}`)
    lines.push('   → 腾讯云平台审核**未通过**（有明确理由），需按理由修改后重新提交。')
    return lines
  }
  lines.push('      ReviewReply 为空 ⇒ **不能断定是被驳回**。按官方口径，-1 至少涵盖三种原因：')
  lines.push('        ① 未通过腾讯云平台审核（通常会给 ReviewReply）')
  lines.push('        ② 首次提交运营商报备失败')
  lines.push('        ③ **未完成首次报备（= 控制台显示「报备中」，属正常等待）**')
  lines.push('   → 去控制台的「报备状态」列看真正的原因：')
  lines.push('        https://console.cloud.tencent.com/smsv2/csms-sign')
  lines.push('      报备中/更新报备中 = 腾讯云平台审核**已通过**，等运营商反馈（平均 7-10 个工作日或更长）。')
  lines.push('   ⚠ 报备中**不要编辑签名、不要重新提交报备** —— 那会把进度推倒重来；')
  lines.push('      报备期间腾讯云也不允许编辑（只能"撤回报备"）。耐心等即可。')
  return lines
}

function explainAuthError(msg: string): string | null {
  if (/not authorized/i.test(msg)) {
    return '子账号缺查询权限（需 sms:DescribeSmsSignList / sms:DescribeSmsTemplateList）。\n' +
      '   若只授了 sms:SendSms，这是预期行为 —— 可到控制台核对签名/模板状态。'
  }
  if (/SecretId is not found/i.test(msg)) return 'SecretId 无效，检查 TENCENT_SMS_SECRET_ID'
  if (/signature/i.test(msg) && /verif/i.test(msg)) return 'SecretKey 与 SecretId 不匹配，检查 TENCENT_SMS_SECRET_KEY'
  return null
}

async function main(): Promise<void> {
  console.log('=== 一、本地配置 ===')
  const mode = smsProviderMode()
  console.log(`SMS_PROVIDER   : ${mode}`)
  const missing = missingTencentSmsKeys()
  console.log(`缺失项         : ${missing.length ? missing.join('、') : '无'}`)

  // 测试码放在最前面几行：它会把「短信通道不可用」这个结论整个改写 ——
  // 通道不可用时，登录**仍然**能在白名单号码上走通，这正是排查时的关键分叉点。
  // 只报「已启用 + 脱敏名单 + 码长 6 位」，**绝不回显码值**（本脚本的输出常被贴到聊天里）。
  const testSms = smsTestCodeConfig()
  if (testSms) {
    console.log(`测试码         : ⚠ 已启用（${testSms.code.length} 位，码值不回显）`)
    console.log(`  白名单       : ${testSms.phones.map(maskPhone).join('、')}`)
    console.log('  说明：白名单手机号「获取验证码」时不走真实通道，输入固定码即可登录。')
    console.log('  仅非 production 生效。联调结束请删掉 .env 里的 SMS_TEST_CODE / SMS_TEST_CODE_PHONES。')
  } else {
    console.log('测试码         : 未启用（SMS_TEST_CODE 未设 / 非 6 位数字 / 白名单为空，或处于 production）')
  }

  const cfg = readTencentSmsConfig()
  if (cfg) {
    console.log(`SecretId       : ${mask(cfg.secretId)}`)
    console.log(`SDKAppID       : ${cfg.sdkAppId}`)
    console.log(`签名（配置值）  : ${cfg.signName}`)
    console.log(`模板 ID        : ${cfg.templateId}`)
    console.log(`Region         : ${cfg.region}`)
  }
  if (mode !== 'tencent') {
    console.log('   ⚠ SMS_PROVIDER 不是 tencent —— 不会走真实通道。')
    console.log('     （本地刻意留空是有意为之：走 dev 日志，联调不花短信费、不依赖外网）')
  }
  if (!cfg) {
    console.log('\n✗ 配置不齐，无法查询腾讯云侧状态。请补齐上面的缺失项。')
    return
  }

  const client = new tencentcloud.sms.v20210111.Client({
    credential: { secretId: cfg.secretId, secretKey: cfg.secretKey },
    region: cfg.region,
    profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com', reqTimeout: 10 } },
  })

  // ───────── 二、签名 ─────────
  console.log('\n=== 二、签名状态（腾讯云侧）===')
  console.log('   ℹ 签名可用状态 = 腾讯云平台审核 + **运营商实名制报备** 的综合结果，')
  console.log('     而 DescribeSmsSignList **只返回综合状态**，没有单独的报备字段 ——')
  console.log('     「报备中」只在控制台可见。详见 https://cloud.tencent.com/document/product/382/117410')
  let signOk = false
  /** -1 且 ReviewReply 为空时的候选中，「报备未完成」占多数 ⇒ 结论段要说"等"而不是"改申" */
  let signMaybeReporting = false
  try {
    const r = await client.DescribeSmsSignList({ International: 0 })
    const list = r.DescribeSignListStatusSet ?? []
    if (!list.length) console.log('   （该账号下没有签名）')
    for (const s of list) {
      const hit = s.SignName === cfg.signName ? ' ← 配置里用的就是它' : ''
      console.log(`   ${verdict(s.StatusCode, s.International)} 「${s.SignName}」（SignId ${s.SignId}）${hit}`)
      if (s.QualificationName) {
        // 资质状态：1 已通过。绑定的资质没过，签名一定过不了 —— 先把这一层排除掉再谈签名本身
        console.log(`      绑定资质：${s.QualificationName}（ID ${s.QualificationId}，状态 ${s.QualificationStatusCode}${s.QualificationStatusCode === 1 ? ' 已通过 ✓' : ''}）`)
      }
      if (s.StatusCode === -1) {
        if (!s.ReviewReply) signMaybeReporting = true
        for (const line of explainUnavailable(s.ReviewReply)) console.log(line)
      }
    }
    signOk = list.some((s) => s.SignName === cfg.signName && s.StatusCode === 0)
    console.log(
      signOk
        ? `   ✓ 配置的签名「${cfg.signName}」可用，可用于发送`
        : `   ✗ 配置的签名「${cfg.signName}」状态不是「可用」—— 现在发送一定失败`,
    )
  } catch (e) {
    const msg = (e as Error).message
    console.log(`   查询失败：${msg.slice(0, 160)}`)
    const hint = explainAuthError(msg)
    if (hint) console.log(`   → ${hint}`)
  }

  // ───────── 三、模板 ─────────
  console.log('\n=== 三、模板状态（腾讯云侧）===')
  let tplOk = false
  try {
    const r = await client.DescribeSmsTemplateList({ International: 0 })
    const list = r.DescribeTemplateStatusSet ?? []
    if (!list.length) console.log('   （该账号下没有模板）')
    for (const t of list) {
      const hit = String(t.TemplateId) === cfg.templateId ? ' ← 配置里用的就是它' : ''
      console.log(`   ${templateVerdict(t.StatusCode)} 「${t.TemplateName}」（TemplateId ${t.TemplateId}）${hit}`)
      console.log(`      内容：${t.TemplateContent ?? ''}`)
      // 模板变量个数必须与代码传参数一致，否则 TemplateParamInconsistent
      const vars = (t.TemplateContent ?? '').match(/\{\d+\}/g)?.length ?? 0
      console.log(`      变量个数：${vars}${vars === 1 ? '（与 sms-provider.ts 传 1 个参数一致 ✓）' : '（⚠ 代码传 1 个参数，不一致会报 TemplateParamInconsistent）'}`)
    }
    tplOk = list.some((t) => String(t.TemplateId) === cfg.templateId && t.StatusCode === 0)
    console.log(
      tplOk
        ? `   ✓ 配置的模板 ${cfg.templateId} 已过审`
        : `   ✗ 配置的模板 ${cfg.templateId} 不在已过审列表中`,
    )
  } catch (e) {
    const msg = (e as Error).message
    console.log(`   查询失败：${msg.slice(0, 160)}`)
    const hint = explainAuthError(msg)
    if (hint) console.log(`   → ${hint}`)
  }

  // ───────── 四、结论 ─────────
  console.log('\n=== 四、结论 ===')
  if (signOk && tplOk) {
    console.log('   ✅ 配置齐全、签名与模板均已过审 —— 可以发真实短信。')
    console.log('   验证：把 .env 的 SMS_PROVIDER 设为 tencent，然后跑 npm run sms:verify')
  } else {
    console.log('   ✗ 还不能发短信。阻塞点：')
    if (!signOk) {
      // ★ 这里是把「等待」和「返工」分开的地方 —— 两者动作完全相反，混为一谈代价很大。
      if (signMaybeReporting) {
        console.log('     · 签名**显示不可用，但很可能只是「报备中」**（腾讯云平台审核已通过）')
        console.log('       → 查控制台的「报备状态」列确认：')
        console.log('          https://console.cloud.tencent.com/smsv2/csms-sign')
        console.log('       → 若显示「报备中」：**什么都不用做，等 7-10 个工作日或更长**；')
        console.log('         报备期间不要编辑签名、不要重新提交报备（会推倒重来）')
        console.log('       → 若显示「报备失败 / 资料异常」：按控制台提示更新资料或换合规签名')
      } else {
        console.log('     · 签名 —— 到 https://console.cloud.tencent.com/smsv2/csms-sign 处理')
      }
    }
    if (!tplOk) console.log('     · 模板 —— 到 https://console.cloud.tencent.com/smsv2/csms-template 处理')
    console.log('   兜底：本地联调可先用「固定测试码」把登录链路跑通（npm run sms:status 第一节会显示是否已启用）')
  }
}

main().catch((e) => {
  console.error('未捕获异常：', e)
  process.exit(1)
})
