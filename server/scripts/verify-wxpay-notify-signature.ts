// 微信支付回调验签契约测试。
//
// 为什么需要它（P1-8）：
//   微信支付对同一商户只启用**一种**微信侧验签凭据 —— 「平台证书」或「微信支付公钥」，
//   二者功能等价、二选一。而**新注册商户（2024 年底起）默认没有平台证书**：
//     GET /v3/certificates → 404 RESOURCE_NOT_EXISTS
//     「无可用的平台证书，请在商户平台-API安全申请使用微信支付公钥」
//   历史实现只接受 `BEGIN CERTIFICATE`，于是这类商户把七项配置全填对了，
//   `wxpayEnabled` 仍然静默为 false —— 表现为「服务器正常启动、下单全被拒」，
//   而且回调验签一律失败（用户付了钱拿不到积分）。属**静默降级**，线上极难排查。
//
// 本测试锁死三件事：
//   A. wechatVerifyMode() 能正确识别两种形态（含无法识别的兜底）
//   B. verifyNotify() 对**两种形态**都能验签通过，且拒绝篡改 / 伪造 / 过期 / 缺头
//   C. 真实导出的 wxpayEnabled 常量在「只给公钥」时确实为 true（子进程验证，
//      因为该常量在模块加载时求值，无法在同进程内改环境重测）
//
// 全部为纯计算 + 临时文件，不碰数据库、不起服务。openssl 缺失时自动跳过证书分支。
// 跑法：npm run wxpay:verify（需在 server/ 目录下，子进程断言依赖本地 tsx）
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifyNotify, wechatVerifyMode, wxpayEnabled, describeNotifySerial } from '../src/lib/wxpay.js'

// ── 子进程模式：只回报「真实 wxpayEnabled 常量」的取值 ──
// 该常量在模块顶层求值，同进程内改 env 不会重算，故用子进程重载模块。
if (process.env.WXPAY_CHILD_ASSERT === '1') {
  console.log(`CHILD_WXPAY_ENABLED=${wxpayEnabled}`)
  process.exit(0)
}

let pass = 0
let fail = 0

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

/** 用给定私钥，按微信回调的签名规则生成一组请求头。 */
function signHeaders(body: string, privateKeyPem: string, tsOffsetSec = 0): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000 + tsOffsetSec).toString()
  const nonce = 'verify-nonce-0001'
  const signature = crypto.createSign('RSA-SHA256').update(`${ts}\n${nonce}\n${body}\n`).sign(privateKeyPem, 'base64')
  return {
    'wechatpay-timestamp': ts,
    'wechatpay-nonce': nonce,
    'wechatpay-signature': signature,
    'wechatpay-serial': 'PUB_KEY_ID_01VERIFYTEST',
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxpay-verify-'))

try {
  // ── 造料：微信侧密钥对（合法签名者）与另一把无关私钥（伪造者）──
  const wechat = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const attacker = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const publicKeyPem = wechat.publicKey

  // 平台证书需要一个 X.509 自签证书 → 借 openssl；不可用则跳过证书分支
  let certificatePem: string | null = null
  try {
    const keyPath = path.join(tmpDir, 'wx.key.pem')
    const certPath = path.join(tmpDir, 'wx.cert.pem')
    fs.writeFileSync(keyPath, wechat.privateKey, { mode: 0o600 })
    execFileSync(
      'openssl',
      ['req', '-new', '-x509', '-key', keyPath, '-out', certPath, '-days', '3650',
        '-subj', '/C=CN/O=Tenpay.com/CN=Tenpay.com'],
      { stdio: 'ignore' },
    )
    certificatePem = fs.readFileSync(certPath, 'utf8')
  } catch {
    console.log('  （本机无 openssl，跳过平台证书分支的密码学断言，仅保留形态识别）')
  }

  const body = JSON.stringify({
    id: 'evt-verify-1',
    event_type: 'TRANSACTION.SUCCESS',
    resource: { ciphertext: 'BASE64CIPHERTEXT', nonce: 'abcdefghijkl', associated_data: 'transaction' },
  })

  console.log('=== A. wechatVerifyMode() 形态识别 ===')
  check('平台证书 PEM → certificate', wechatVerifyMode('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'), 'certificate')
  check('微信支付公钥 PEM → public-key', wechatVerifyMode('-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----\n'), 'public-key')
  check('真实公钥 → public-key', wechatVerifyMode(publicKeyPem), 'public-key')
  check('空值 → none', wechatVerifyMode(''), 'none')
  check('乱填内容 → none（不能瞎猜）', wechatVerifyMode('some random text'), 'none')

  /** 对给定验签材料跑一整套验签断言 */
  function verifyMatrix(label: string, material: string): void {
    console.log(`\n=== B. verifyNotify() 验签矩阵 —— ${label} ===`)
    check('合法签名 → 通过', verifyNotify(signHeaders(body, wechat.privateKey), body, material), true)
    check('报文被篡改 → 拒绝', verifyNotify(signHeaders(body, wechat.privateKey), `${body} `, material), false)
    check('用另一把私钥签名（伪造） → 拒绝', verifyNotify(signHeaders(body, attacker.privateKey), body, material), false)
    check('时间戳超 5 分钟窗口 → 拒绝', verifyNotify(signHeaders(body, wechat.privateKey, -600), body, material), false)
    check('未来时间戳超窗口 → 拒绝', verifyNotify(signHeaders(body, wechat.privateKey, +600), body, material), false)
    check('缺 wechatpay-signature → 拒绝', verifyNotify({
      'wechatpay-timestamp': String(Math.floor(Date.now() / 1000)),
      'wechatpay-nonce': 'n',
    }, body, material), false)
    check('时间戳非数字 → 拒绝', verifyNotify({
      ...signHeaders(body, wechat.privateKey), 'wechatpay-timestamp': 'not-a-number',
    }, body, material), false)
    check('验签材料为空 → 拒绝（不得放行）', verifyNotify(signHeaders(body, wechat.privateKey), body, ''), false)
  }

  verifyMatrix('微信支付公钥（新商户默认模式）', publicKeyPem)
  if (certificatePem) verifyMatrix('平台证书（旧商户 / 向后兼容）', certificatePem)

  console.log('\n=== C. describeNotifySerial() 仅提示、绝不拒绝 ===')
  {
    const ID = 'PUB_KEY_ID_0117504054172026091500191587002400'
    check('未配置公钥 ID → 明确标注「未核对」', describeNotifySerial('X', '').includes('未核对'), true)
    check('一致 → 标注一致', describeNotifySerial(ID, ID).includes('一致'), true)
    check('不一致 → 仍标注「不拒绝」★不得带任何拒绝语义', describeNotifySerial('OTHER_ID', ID).includes('不拒绝'), true)
    check('头缺失 → 如实说明缺失', describeNotifySerial(undefined, ID).includes('缺失'), true)
  }

  console.log('\n=== D. 真实 wxpayEnabled 常量（子进程重载模块）===')
  check('本机未配置支付凭据时 → false（fail-closed，不得静默进入真实支付）', wxpayEnabled, false)
  {
    const tsxBin = path.join(process.cwd(), 'node_modules', '.bin', 'tsx')
    const selfPath = path.resolve('scripts/verify-wxpay-notify-signature.ts')
    if (fs.existsSync(tsxBin) && fs.existsSync(selfPath)) {
      const childEnv = {
        ...process.env,
        WXPAY_CHILD_ASSERT: '1',
        WX_PAY_MCH_ID: '1750405417',
        WX_PAY_API_KEY_V3: 'k'.repeat(32),
        WX_PAY_SERIAL_NO: '1204C7CC081673C55BE86130772AFE9B585CB2A8',
        WX_PAY_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nX\\n-----END PRIVATE KEY-----',
        WX_APPID: 'wx3004f53da3e30a36',
        WX_PAY_NOTIFY_URL: 'https://api.example.com/api/v1/pay/notify',
        WX_PAY_PLATFORM_CERT: publicKeyPem,
      }
      const out = execFileSync(tsxBin, [selfPath], { env: childEnv, encoding: 'utf8', cwd: process.cwd() })
      check('七项齐备且验签凭据为「微信支付公钥」 → wxpayEnabled 为 true ★核心回归', out.includes('CHILD_WXPAY_ENABLED=true'), true)
    } else {
      console.log('  （未找到本地 tsx 或脚本路径，跳过子进程断言；请用 npm run wxpay:verify 运行）')
    }
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

console.log(`\n★ ${fail === 0 ? '全部通过' : '存在失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
