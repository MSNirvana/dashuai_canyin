// 火山 TTS「音色 × 资源版本」可用性预检（2026-09-21）
//
// 为什么需要它：AI 档（ChatCut）的配音链路里，`synthesizeNarration()` 失败是**直接抛错**的
// （chatcut-driver.ts 的配音循环只有 try/finally，没有 catch），也就是说
// **一个坏 speaker id = 整单渲染失败 + 用户白等**（积分已冻结）。
// 而这 5 个对外档位是抽象档位，落到火山要真实 speaker id —— 各账号开通的音色不同，
// **不能猜**。所以在写库之前，先把候选逐一打一遍，只保留真实可用的。
//
// 用法（不要把 key 写进任何文件；本仓库是 public）：
//   cd server && VOLCANO_TTS_API_KEY=xxx npx tsx scripts/probe-volcano-speakers.ts
// 只想测指定的：
//   VOLCANO_TTS_API_KEY=xxx EXTRA_CANDIDATES='seed-tts-2.0:zh_female_xxx' npx tsx scripts/probe-volcano-speakers.ts
//
// 判据：HTTP 200 + 收到音频分片 = 可用；code≠20000000 / 无音频 = 不可用（打印真实报错）。
// 不写库、不落文件、不打印 key（只打印长度）。
import { randomUUID } from 'node:crypto'

const URL_ = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
const END_CODE = 20000000
const TEXT = '今天这道招牌菜，肥而不腻，入口即化。'

const TOKEN = (process.env.VOLCANO_TTS_API_KEY ?? '').trim()
if (!TOKEN) {
  console.error('缺少 VOLCANO_TTS_API_KEY。用法：VOLCANO_TTS_API_KEY=xxx npx tsx scripts/probe-volcano-speakers.ts')
  process.exit(2)
}

/**
 * 候选音色清单。★ 真实可用范围以火山控制台「音色管理」为准，这里只是待验清单。
 *
 * ★★ 不要给音色预设 resourceId —— 实测教训（2026-09-21）：
 *    `zh_female_wanwanxiaohe_moon_bigtts` 我按名字猜成 2.0，结果回
 *    `code 55000000 "resource ID is mismatched with speaker related resource"`，
 *    看着像「音色没开通」，其实是**配对错了**。同一批 `_moon_bigtts` 里
 *    「温暖阿虎」就是 1.0 的。名字里看不出归属 ⇒ 只能自动试。
 */
const SPEAKERS: Array<{ speaker: string; note: string }> = [
  { speaker: 'zh_female_qinqienv_uranus_bigtts', note: '亲切女声' },
  { speaker: 'zh_female_wanwanxiaohe_moon_bigtts', note: '湾湾小何' },
  { speaker: 'zh_female_gaolengyujie_moon_bigtts', note: '高冷御姐' },
  { speaker: 'zh_female_meilinvyou_moon_bigtts', note: '魅力女友' },
  { speaker: 'zh_female_shuangkuaisisi_moon_bigtts', note: '爽快思思' },
  { speaker: 'zh_female_cancan_mars_bigtts', note: '灿灿' },
  { speaker: 'zh_male_wennuanahu_moon_bigtts', note: '温暖阿虎' },
  { speaker: 'zh_male_beijingxiaoye_moon_bigtts', note: '北京小爷' },
  { speaker: 'zh_male_jieshuonansheng_mars_bigtts', note: '解说男声' },
  { speaker: 'zh_male_chunhou_moon_bigtts', note: '醇厚男声' },
  { speaker: 'zh_male_yuanboxiaoshu_moon_bigtts', note: '渊博小叔' },
  { speaker: 'zh_male_sysong_mars_bigtts', note: '系统男声' },
]

/** 依次尝试的资源版本（命中第一个就停） */
const RESOURCE_IDS = ['seed-tts-2.0', 'seed-tts-1.0']

const EXTRA = (process.env.EXTRA_CANDIDATES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
for (const raw of EXTRA) {
  const [a, b] = raw.split(':')
  // 允许两种写法：`speaker`（自动试资源）或 `resourceId:speaker`（只试指定资源）
  if (b) SPEAKERS.push({ speaker: b, note: `自定义(${a})` })
  else if (a) SPEAKERS.push({ speaker: a, note: '自定义' })
}

interface Probe {
  ok: boolean
  bytes: number
  code?: number
  message?: string
  http?: number
  /** 认不出的原始报文（截断）—— 实测有些拒单既不回 code 也不回 message，只回别的东西 */
  raw?: string
}

async function probe(resourceId: string, speaker: string): Promise<Probe> {
  let res: Response
  try {
    res = await fetch(URL_, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': TOKEN,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Connect-Id': randomUUID(),
      },
      body: JSON.stringify({
        user: { uid: 'dashuai-probe' },
        req_params: {
          text: TEXT,
          speaker,
          audio_params: { format: 'mp3', sample_rate: 24000, bit_rate: 128000, speech_rate: 0 },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    return { ok: false, bytes: 0, message: `网络失败: ${(e as Error).message}` }
  }
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '')
    return { ok: false, bytes: 0, http: res.status, message: body.slice(0, 200) }
  }

  let bytes = 0
  let code: number | undefined
  let message: string | undefined
  let raw: string | undefined
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let obj: { code?: number; data?: string | null; message?: string }
      try {
        obj = JSON.parse(line)
      } catch {
        raw ??= line.slice(0, 300)
        continue
      }
      if (obj.code === END_CODE) continue
      if (obj.code === 0 && typeof obj.data === 'string') bytes += Buffer.from(obj.data, 'base64').length
      else if (obj.code !== 0) {
        code = obj.code
        message = obj.message
      } else {
        raw ??= line.slice(0, 300)
      }
    }
  }
  // 流里没换行的尾巴（有些错误直接回一整块 JSON）也别丢
  if (!raw && bytes === 0 && buf.trim()) raw = buf.trim().slice(0, 300)
  return { ok: bytes > 0, bytes, code, message, raw }
}

async function main() {
  console.log(`[预检] token 长度=${TOKEN.length}（不回显）；候选音色 ${SPEAKERS.length} 个；资源版本 ${RESOURCE_IDS.join(' → ')}\n`)
  const rows: Array<{ speaker: string; note: string; resourceId?: string; r: Probe }> = []
  for (const c of SPEAKERS) {
    let last: Probe = { ok: false, bytes: 0 }
    let hit: string | undefined
    for (const resourceId of RESOURCE_IDS) {
      const r = await probe(resourceId, c.speaker)
      last = r
      if (r.ok) {
        hit = resourceId
        break
      }
    }
    rows.push({ ...c, resourceId: hit, r: last })
    const tag = hit ? '✓ 可用' : '✗ 不可用'
    const detail = hit
      ? `${hit.padEnd(13)} ${last.bytes} 字节音频`
      : [last.http ? `HTTP ${last.http}` : '', last.code ? `code=${last.code}` : '', last.message ?? '', last.raw ?? ''].filter(Boolean).join(' ')
    console.log(`${tag}  ${c.speaker.padEnd(42)} ${c.note.padEnd(6)} ${detail}`)
  }

  const usable = rows.filter((row) => row.resourceId)
  console.log(`\n可用 ${usable.length} / ${SPEAKERS.length}`)
  const byResource = new Map<string, typeof usable>()
  for (const u of usable) byResource.set(u.resourceId!, [...(byResource.get(u.resourceId!) ?? []), u])
  for (const [resourceId, list] of byResource) {
    console.log(`\n[${resourceId}] ${list.length} 个 —— ★ 同一供应商只有一个 extraJson.resourceId，`)
    console.log('  所以面板上的音色档位必须**全部取自同一个 resourceId**（否则那个档位必然失败）：')
    for (const u of list) console.log(`  CHATCUT_TTS_VOICE_X=${u.speaker}   # ${u.note}`)
  }
  process.exit(usable.length ? 0 : 1)
}

main().catch((e) => {
  console.error('预检异常:', e instanceof Error ? e.message : e)
  process.exit(1)
})
