/**
 * 只保证「演示账号」那一行配置存在（**create-only，绝不覆盖已有值**）。
 *
 * ★ 为什么必须单独一个脚本、而不是 `npm run db:seed`：
 *   `prisma/seed.ts` 的 settings 段是「**update 覆盖 settingVal**」的写法 ——
 *   在生产上跑一次，会把运营改过的 `bean` / `render` / `storage` / `subscription`
 *   配置**全部打回默认值**（积分汇率、AI 成本系数、合成系数、订阅价……）。
 *   它不会报错，只会让计费口径悄悄变掉。演示账号只需要加**一行**，
 *   就用这个最小脚本。
 *
 * ★ 为什么这一行值得预置：分组名与键名必须与代码里的常量**逐字一致**
 *   （`demo` / `config`）。让运营在后台「新增配置」手敲，敲错了**不会报错**，
 *   只会表现为「配了却不生效」——最典型的静默失效。
 *   预置好这一行，运营只需要改它的**值**。
 *
 * ★ create-only：已有值一律不动（运营填过的演示手机号必须活下来；
 *   `prisma/seed.ts` 里那一行也是同样的「不存在才建」写法）。
 *
 * 用法（在 server/ 下）：
 *   npx tsx scripts/seed-demo-account-config.ts          # 默认 dry-run，只看会做什么
 *   npx tsx scripts/seed-demo-account-config.ts --yes    # 真的写
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const GROUP = 'demo'
const KEY = 'config'
const VALUE = JSON.stringify({ phones: [], window_hours: 24, login_code: '' })
const DISPLAY = '演示账号'
const DESC =
  'phones=演示账号手机号数组（留空即关闭演示，不是"所有号"）；window_hours=窗口时长(小时)，从首次登录起算且全局一次性；login_code=固定登录码（恰好 6 位数字），配了它白名单号登录时不必获取短信验证码（留空=不启用，绝不是"任何码都行"）。首次登录后会自动出现 demo.activated_at，重开窗口＝把它的值改成当前时间，或删掉那一行。'

async function main(): Promise<void> {
  const yes = process.argv.includes('--yes')
  const cur = await prisma.systemSetting.findUnique({
    where: { groupKey_settingKey: { groupKey: GROUP, settingKey: KEY } },
  })

  if (cur) {
    console.log(`已存在 ${GROUP}.${KEY}：`)
    console.log(`  值 = ${cur.settingVal}`)
    console.log('create-only ⇒ 不做任何修改。')
    console.log('（要重开演示窗口：改这个值，或删掉这一行让下次登录重新激活）')
    return
  }

  console.log(`将创建 ${GROUP}.${KEY}：`)
  console.log(`  值 = ${VALUE}`)
  console.log(`  类型 = JSON，isPublic = false（账号白名单，绝不能公开）`)
  if (!yes) {
    console.log('\n（dry-run：未写入。确认无误后加 --yes）')
    return
  }

  await prisma.systemSetting.create({
    data: {
      groupKey: GROUP,
      settingKey: KEY,
      settingVal: VALUE,
      valueType: 'JSON',
      displayName: DISPLAY,
      description: DESC,
      sort: 0,
      isPublic: false,
    },
  })
  console.log('已创建。到后台左侧「演示账号」页把手机号（和可选的 6 位登录验证码）填好并保存即可启用。')
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
