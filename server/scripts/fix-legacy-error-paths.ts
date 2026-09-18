/**
 * 一次性数据订正：清掉 render_task.error_msg 里的**服务端本机绝对路径**。
 *
 * 背景：`copyFile` 抛出的 ENOENT 原文里带着两侧的绝对路径（源是本机存储根，目标还是系统
 * 临时目录）。实测存量里有 5 条（id 17/18/19/20/22，都是本地冒烟数据）写着
 * `/Users/gaoyunhong/Documents/ChatGPT/Evvvv/server/storage/uploads/1/smoke-*.mp4`。
 *
 * ★ 只订正「本机路径」这一类，**不动**含第三方产品名的行：
 *   - 路径对运维也没有价值（有用的只是「哪个对象键丢了」），订正后信息量反而更准；
 *   - 而 `ChatCut …HTTP 400：{...}` 那类是运维定位通道问题的唯一线索，洗掉等于自断线索。
 *     用户端看不到它是靠**读出口**兜的（`src/render/user-errors.ts` → `toView().errorText`），
 *     不是靠洗库 —— 见该文件顶部注释。
 *
 * 跑法：npx tsx scripts/fix-legacy-error-paths.ts          # 预演，只打印
 *       npx tsx scripts/fix-legacy-error-paths.ts --write  # 落盘
 */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const WRITE = process.argv.includes('--write')
/** 机器路径的特征：POSIX 家目录/系统目录，或 Windows 盘符 */
const MACHINE_PATH = /\/Users\/|\/home\/|\/private\/|\/var\/folders\/|[A-Za-z]:\\/

/** 从 `copyfile '<源>' -> '<目标>'` 里把对象键抠出来（`storage/` 之后的全部） */
function extractObjectKey(msg: string): string | null {
  const m = /copyfile '([^']+)'/.exec(msg)
  if (!m?.[1]) return null
  const idx = m[1].indexOf('/storage/')
  return idx >= 0 ? m[1].slice(idx + '/storage/'.length) : null
}

async function main() {
  const rows = await prisma.renderTask.findMany({
    where: { errorMsg: { not: null } },
    select: { id: true, status: true, errorCode: true, errorMsg: true },
  })
  const hits = rows.filter((r) => MACHINE_PATH.test(r.errorMsg ?? ''))
  console.log(`扫描 ${rows.length} 条有 error_msg 的任务，命中机器路径的 ${hits.length} 条${WRITE ? '（--write 落盘）' : '（预演，加 --write 才写库）'}`)
  let changed = 0
  for (const r of hits) {
    const raw = r.errorMsg ?? ''
    const key = extractObjectKey(raw)
    // 保留可诊断的部分（对象键），丢掉机器路径
    const next = key ? `源文件不存在或已被清理：${key}` : '源素材文件读取失败（文件不存在或已被清理）'
    console.log(`- id=${r.id.toString()} ${r.status}/${r.errorCode}`)
    console.log(`    旧：${raw.slice(0, 140)}${raw.length > 140 ? '…' : ''}`)
    console.log(`    新：${next}`)
    if (WRITE) {
      await prisma.renderTask.update({ where: { id: r.id }, data: { errorMsg: next } })
      changed++
    }
  }
  console.log(WRITE ? `已更新 ${changed} 条` : `预演完成：将有 ${hits.length} 条被改写`)
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect(); process.exit() })
