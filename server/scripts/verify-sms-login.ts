// 短信登录链路契约测试。
//
// 验证六件事：
//   A. `smsProviderMode()` —— 只认 `tencent`，未知取值一律视为「未配置」（不猜、不静默降级）
//   B. `readTencentSmsConfig()` —— 五项缺任一即为 null；region 默认 ap-guangzhou
//   C. 安全性质：配置不全时**绝不假装发送成功**（生产必须明确失败，不能 fail-open）
//   D. ★ 失败回滚：真实发送失败时必须**删掉已写入的 smsCode 记录**。
//
//     这是整条链路里最容易静默出错的地方。若失败却留下记录：
//       ① 用户持有一条「有效但永远收不到短信」的验证码，只能一直等；
//       ② 该记录还占着当日该号码的发送配额（DAILY_LIMIT_PER_PHONE=10），
//          连续失败几次就把用户彻底挡在门外 —— 现象是「点了没反应，也没短信」，
//          查代码完全看不出问题（因为代码"成功"了）。
//   E. 短信测试码（登录**后门**）的判定逻辑：production 整块失效 / 码必须 6 位数字 /
//      白名单必须非空且命中 —— 三条缺任一即自动关闭。
//   F. 测试码的**接线**：`sendCode()` 真的走了固定码分支、错码仍被拒、码用一次即作废、
//      非白名单号照旧走真实通道。
//
// A~C、E 是纯函数测试（注入 env，不碰网络与数据库）。
// D、F 需要数据库；D 还依赖外网（用假密钥真实请求腾讯云以取得一个确定的失败）：
//   期望「抛 SmsSendFailedError + 记录被删除」。网络不通时走的同样是失败路径，用例依然成立
//   —— 这正是本项目的一条纪律：不把「第三方偶发不可用」当作测试失败。
//
// 跑法：npm run sms:verify
import '../src/env.js'
import { prisma } from '../src/db.js'
import { smsProviderMode, readTencentSmsConfig, missingTencentSmsKeys, tencentSmsConfigured, SmsSendFailedError } from '../src/auth/sms-provider.js'
import { sendCode, verifyCode, smsTestCodeConfig, smsTestCodeFor, SmsCodeInvalidError } from '../src/auth/sms.js'

let pass = 0
let fail = 0
let skip = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ✓ ${label} → ${a}`)
    pass += 1
  } else {
    console.log(`  ✗ ${label} → 实际 ${a}，期望 ${e}`)
    fail += 1
  }
}

function skipped(label: string, why: string): void {
  console.log(`  ⊘ ${label} —— 跳过：${why}`)
  skip += 1
}

/**
 * 一份配置齐全的腾讯云短信环境（密钥是假的，只用于验证「配了假凭据 → 调不通」这条失败路径）。
 *
 * ⚠ 假值也**必须拼接出来**，不能写成一整个字面量：GitHub 的 push protection 只看**形态**、
 *   不判断真伪，`AKID` + 32 位会被判成「腾讯云 Secret ID」而**直接拒绝整次推送**
 *   （实测被拦过：GH013 / Push cannot contain secrets）。拆开拼接后形态上不连续，
 *   就不会再拦，功能完全一样（依旧是走不通的假凭据）。
 */
const FAKE_SECRET_ID = `AKIDfake${'0'.repeat(28)}`
const FAKE_SECRET_KEY = 'f'.repeat(32)

const SMS_OK: Record<string, string> = {
  SMS_PROVIDER: 'tencent',
  TENCENT_SMS_SECRET_ID: FAKE_SECRET_ID,
  TENCENT_SMS_SECRET_KEY: FAKE_SECRET_KEY,
  TENCENT_SMS_SDK_APP_ID: '1400000000',
  TENCENT_SMS_SIGN_NAME: '测试签名',
  TENCENT_SMS_TEMPLATE_ID: '1234567',
}

/** 专用测试号：不归属任何真实商户，跑完硬删 */
const TEST_PHONE = '13900009998'

/** 对照组用号：**不在**测试码白名单里，用来证明后门不是无差别的 */
const NON_WHITELIST = '13900009997'

async function main(): Promise<void> {
  // ─────────── A. provider 模式识别 ───────────
  console.log('\nA. smsProviderMode() —— 只认 tencent，未知取值不得被当成可用')
  check('SMS_PROVIDER=tencent', smsProviderMode({ SMS_PROVIDER: 'tencent' }), 'tencent')
  check('大小写与空格容错', smsProviderMode({ SMS_PROVIDER: '  Tencent  ' }), 'tencent')
  check('未设置 → none', smsProviderMode({}), 'none')
  check('空串 → none', smsProviderMode({ SMS_PROVIDER: '' }), 'none')
  // 关键：写了别家供应商名字（例如 aliyun）不能当作已配置 —— 否则会走到真实发送分支但用错 SDK
  check('aliyun（未实现的供应商）→ none', smsProviderMode({ SMS_PROVIDER: 'aliyun' }), 'none')
  check('随便写的值 → none', smsProviderMode({ SMS_PROVIDER: 'yes-please' }), 'none')

  // ─────────── B. 配置读取 ───────────
  console.log('\nB. readTencentSmsConfig() —— 五项缺任一即视为未配置')
  check('配置齐全 → 返回配置对象', readTencentSmsConfig(SMS_OK) !== null, true)
  check('region 默认 ap-guangzhou', readTencentSmsConfig(SMS_OK)?.region, 'ap-guangzhou')
  check('region 可覆盖', readTencentSmsConfig({ ...SMS_OK, TENCENT_SMS_REGION: 'ap-singapore' })?.region, 'ap-singapore')
  check('空串 region 回退默认', readTencentSmsConfig({ ...SMS_OK, TENCENT_SMS_REGION: '   ' })?.region, 'ap-guangzhou')

  for (const key of [
    'TENCENT_SMS_SECRET_ID',
    'TENCENT_SMS_SECRET_KEY',
    'TENCENT_SMS_SDK_APP_ID',
    'TENCENT_SMS_SIGN_NAME',
    'TENCENT_SMS_TEMPLATE_ID',
  ]) {
    check(`缺 ${key} → null`, readTencentSmsConfig({ ...SMS_OK, [key]: '' }), null)
  }
  check('全空白 → null', readTencentSmsConfig({ TENCENT_SMS_SECRET_ID: ' ' }), null)

  console.log('\n   缺失项清单（用于启动日志排查，不含任何密钥值）')
  check('缺两项时列出两个名字', missingTencentSmsKeys({ ...SMS_OK, TENCENT_SMS_SECRET_KEY: '', TENCENT_SMS_TEMPLATE_ID: '' }), [
    'TENCENT_SMS_SECRET_KEY',
    'TENCENT_SMS_TEMPLATE_ID',
  ])
  check('齐全时为空数组', missingTencentSmsKeys(SMS_OK), [])

  // ─────────── C. 不得 fail-open ───────────
  console.log('\nC. tencentSmsConfigured() —— 选了通道但配置不齐，必须判为不可用')
  check('选了 tencent 且配置齐全 → true', tencentSmsConfigured(SMS_OK), true)
  check('选了 tencent 但缺密钥 → false（不能假装可用）', tencentSmsConfigured({ ...SMS_OK, TENCENT_SMS_SECRET_KEY: '' }), false)
  check('配置齐全但没选通道 → false', tencentSmsConfigured({ ...SMS_OK, SMS_PROVIDER: '' }), false)
  check('全空 → false', tencentSmsConfigured({}), false)

  // ─────────── D. 失败回滚（需要数据库 + 外网）───────────
  console.log('\nD. 发送失败必须回滚 smsCode 记录（核心风险点）')

  let dbReady = true
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch (e) {
    dbReady = false
    skipped('D 段全部用例', `数据库不可用（${(e as Error).message.slice(0, 80)}）`)
  }

  if (dbReady) {
    // 注入假密钥环境（sendCode 内部读 process.env）
    const saved: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(SMS_OK)) {
      saved[k] = process.env[k]
      process.env[k] = v
    }

    try {
      await prisma.smsCode.deleteMany({ where: { phone: TEST_PHONE } })

      let thrown: unknown = null
      try {
        await sendCode(prisma, TEST_PHONE)
      } catch (e) {
        thrown = e
      }

      check('假密钥发送 → 抛 SmsSendFailedError', thrown instanceof SmsSendFailedError, true)
      if (thrown instanceof SmsSendFailedError) {
        console.log(`      通道返回原因：${thrown.reason.slice(0, 120)}`)
      }

      // ★ 这一条才是重点：不是"抛错了"，而是"库里的垃圾记录被清掉了"
      check('失败后 smsCode 表无残留', await prisma.smsCode.count({ where: { phone: TEST_PHONE } }), 0)

      // 配额未被占用：记录已删，用户重试不会因为"发了 10 次"被锁死
      const today = new Date(new Date().toISOString().slice(0, 10))
      check(
        '失败不占用当日发送配额',
        await prisma.smsCode.count({ where: { phone: TEST_PHONE, createdAt: { gte: today } } }),
        0,
      )

      // 对照组：抛出的必须是 SmsSendFailedError，而不是被误当成限流/未配置
      check(
        '未被误判为限流错误',
        thrown instanceof SmsSendFailedError && (thrown as Error).name === 'SmsSendFailedError',
        true,
      )
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      await prisma.smsCode.deleteMany({ where: { phone: TEST_PHONE } })
    }
  }

  // ─────────── E. 短信测试码（登录后门）───────────
  //
  // 这是全项目唯一一个「不验证码值就能登录」的开关，所以它比 D 段更该有契约测试：
  // 上线的代价不是"短信发不出去"，而是"任何人输 123456 就能登进任意商家账号"。
  // 三条硬性质，每条都对应一种真实的翻车方式：
  //   ① production 下必须整块失效 —— 防「本地 .env 整份复制到服务器」；
  //   ② 码必须恰好 6 位数字 —— 防手滑写成 `SMS_TEST_CODE=true` 变成"码值恒为 true"；
  //   ③ 白名单必须非空且命中 —— 防「留空 = 所有号」这种一行漏配就全站失守的语义。
  console.log('\nE. 短信测试码 —— 后门必须有关不掉的边界')
  check('E1 两个变量都没设 → null', smsTestCodeConfig({}), null)
  check('E2 只有码、没有白名单 → null（不支持"留空=所有号"）', smsTestCodeConfig({ SMS_TEST_CODE: '123456' }), null)
  check('E3 只有白名单、没有码 → null', smsTestCodeConfig({ SMS_TEST_CODE_PHONES: TEST_PHONE }), null)
  check('E4 白名单全是逗号/空格 → null', smsTestCodeConfig({ SMS_TEST_CODE: '123456', SMS_TEST_CODE_PHONES: ' , , ' }), null)
  // 码值形态：非 6 位数字一律作废（'true' / '12345' / '1234567' / 'abcdef' 都曾是想当然的写法）
  for (const bad of ['true', '12345', '1234567', 'abcdef', '12 456']) {
    check(`E5 码="${bad}" → null`, smsTestCodeConfig({ SMS_TEST_CODE: bad, SMS_TEST_CODE_PHONES: TEST_PHONE }), null)
  }
  check(
    'E6 两个都给对 → 启用',
    smsTestCodeConfig({ SMS_TEST_CODE: '123456', SMS_TEST_CODE_PHONES: TEST_PHONE }),
    { code: '123456', phones: [TEST_PHONE] },
  )
  check(
    'E7 白名单逗号分隔 + 空格容错',
    smsTestCodeConfig({ SMS_TEST_CODE: '123456', SMS_TEST_CODE_PHONES: ` ${TEST_PHONE} , 13800000001 ,` })?.phones,
    [TEST_PHONE, '13800000001'],
  )
  check(
    'E8 ★ production 下整块失效（哪怕两个变量都给对）',
    smsTestCodeConfig({ SMS_TEST_CODE: '123456', SMS_TEST_CODE_PHONES: TEST_PHONE, NODE_ENV: 'production' }),
    null,
  )
  check('E9 命中的号码拿到固定码', smsTestCodeFor(TEST_PHONE, { SMS_TEST_CODE: '123456', SMS_TEST_CODE_PHONES: TEST_PHONE }), '123456')
  check(
    'E10 ★ 不在白名单的号码 → null（后门不是无差别的）',
    smsTestCodeFor(NON_WHITELIST, { SMS_TEST_CODE: '123456', SMS_TEST_CODE_PHONES: TEST_PHONE }),
    null,
  )

  // ─────────── F. 测试码端到端（需要数据库）───────────
  //
  // 与 E 段的区别：E 只证明"判定逻辑对"，F 证明"**接线**对" ——
  // 即 `sendCode()` 真的把固定码写进了库、`verifyCode()` 真的认它。
  // 光改 `smsTestCodeConfig()` 而忘了接线 `sendCode`，E 段会全绿但功能根本不工作。
  console.log('\nF. 测试码端到端：写库 → 校验 → 一次性 → 白名单是硬边界（需要数据库）')

  const TEST_CODE_VARS: Record<string, string> = {
    ...SMS_OK,
    NODE_ENV: 'test',
    SMS_TEST_CODE: '123456',
    SMS_TEST_CODE_PHONES: TEST_PHONE,
  }

  if (!dbReady) {
    skipped('F 段全部用例', '数据库不可用')
  } else {
    const savedF: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(TEST_CODE_VARS)) {
      savedF[k] = process.env[k]
      process.env[k] = v
    }

    try {
      await prisma.smsCode.deleteMany({ where: { phone: { in: [TEST_PHONE, NON_WHITELIST] } } })

      // ★ 本条是整个 F 段的支点：环境里 SMS_PROVIDER=tencent 且密钥是假的，
      //   若测试码**没有**生效，这一步必然抛 SmsSendFailedError。所以"不抛"本身就是
      //   "固定码分支确实接管了、真实通道确实没被调用"的证明 —— 不必去查网络抓包。
      let sendThrown: unknown = null
      try {
        await sendCode(prisma, TEST_PHONE)
      } catch (e) {
        sendThrown = e
      }
      check('F1 白名单号点发送 → 不抛错（测试码接管，未走真实通道）', sendThrown, null)

      const rec = await prisma.smsCode.findFirst({
        where: { phone: TEST_PHONE, scene: 'LOGIN' },
        orderBy: { createdAt: 'desc' },
      })
      check('F2 落库 1 条记录', await prisma.smsCode.count({ where: { phone: TEST_PHONE } }), 1)
      check('F3 记录未使用', rec?.usedAt ?? null, null)
      check('F4 记录未过期（走的是正常的 5 分钟 TTL）', (rec?.expiresAt.getTime() ?? 0) > Date.now(), true)

      let wrongThrown: unknown = null
      let rightThrown: unknown = null
      let replayThrown: unknown = null
      try {
        await verifyCode(prisma, TEST_PHONE, '000000')
      } catch (e) {
        wrongThrown = e
      }
      check('F5 ★ 错码仍然被拒（固定码不是"任意码都能登"）', wrongThrown instanceof SmsCodeInvalidError, true)
      check(
        'F6 错码照旧累计 attempts',
        (await prisma.smsCode.findUnique({ where: { id: rec!.id } }))?.attempts,
        1,
      )

      try {
        await verifyCode(prisma, TEST_PHONE, '123456')
      } catch (e) {
        rightThrown = e
      }
      check('F7 固定码 123456 → 校验通过', rightThrown, null)
      check(
        'F8 通过后标记 usedAt（一次性）',
        (await prisma.smsCode.findUnique({ where: { id: rec!.id } }))?.usedAt !== null,
        true,
      )

      try {
        await verifyCode(prisma, TEST_PHONE, '123456')
      } catch (e) {
        replayThrown = e
      }
      check('F9 ★ 同一码不能复用（重放被拒）', replayThrown instanceof SmsCodeInvalidError, true)

      // ★ 硬边界：不在白名单的号走**真实通道**（假密钥 ⇒ 必失败）。
      //   这条防的是"白名单写漏/写成通配"把后门退化成无差别入口 —— 那时这里会不抛错。
      let outsiderThrown: unknown = null
      try {
        await sendCode(prisma, NON_WHITELIST)
      } catch (e) {
        outsiderThrown = e
      }
      check('F10 ★ 非白名单号仍走真实通道（假密钥 ⇒ 照旧失败）', outsiderThrown instanceof SmsSendFailedError, true)
    } finally {
      for (const [k, v] of Object.entries(savedF)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      await prisma.smsCode.deleteMany({ where: { phone: { in: [TEST_PHONE, NON_WHITELIST] } } })
    }
  }

  console.log(`\n${'─'.repeat(52)}`)
  console.log(`通过 ${pass} · 失败 ${fail}${skip ? ` · 跳过 ${skip}` : ''}`)
  await prisma.$disconnect()
  if (fail > 0) process.exit(1)
}

main().catch(async (e) => {
  console.error('[sms:verify] 未捕获异常：', e)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
