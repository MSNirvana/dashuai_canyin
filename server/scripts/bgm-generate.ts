/**
 * 用 ChatCut 生成配乐并落进本地曲库 —— `npm run bgm:generate -- --style=LIGHT --yes`
 *
 * ★ 这个脚本存在的理由：配乐此前要么靠合成的一条和弦床（听感是嗡，不是曲子），
 *   要么靠运维手工放一个 `DEFAULT_BGM_PATH`（且所有风格共用同一首）。
 *   而 ChatCut 的 `submit_music` 是**真音乐生成**（mureka-9），
 *   生成的素材又能用 `request_asset_download` 取回本地 —— 于是可以
 *   「用 ChatCut 只做配乐、渲染仍然留在本地」，既拿到真曲子，
 *   又不动本地引擎（本地引擎上挂着字幕位置/分段/接缝帧率那些修复，换引擎会把它们全废掉）。
 *
 * ★★ 关键设计：联网只发生在**本脚本**里（运维动作），渲染管线只读本地文件。
 *   所以 ChatCut 挂了 / 额度耗尽了，只是「不能补曲库」，不会让出片失败。
 *
 * ★ 与 `chatcut-call.ts` 同一套安全约定：**默认 dry-run**（只打印将发送的请求），
 *   加 `--yes` 才真发。因为 `submit_music` 是**消耗 ChatCut 额度**的调用
 *   （对方 schema 原文：this tool costs ChatCut credits）。
 *
 * 用法：
 *   npm run bgm:generate -- --style=LIGHT              # 先看会发什么（不发）
 *   npm run bgm:generate -- --style=LIGHT --yes        # 真生成一首 LIGHT
 *   npm run bgm:generate -- --style=ALL --yes          # 三个风格都补齐
 *   npm run bgm:generate -- --list                     # 只看曲库现状
 *
 * 可选参数：
 *   --project=<projectId>   指定落进哪个 ChatCut 项目（默认读 CHATCUT_BGM_PROJECT_ID，
 *                           都没有就新建一个名为 dashuai-bgm-library 的项目）
 *   --wait=<秒>             等待生成的就绪预算（默认 300）
 */
import 'dotenv/config'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { prisma, redis } from '../src/db.js'
import {
  BGM_STYLES,
  bgmLibraryDir,
  bgmMetadataPath,
  describeBgmLibrary,
  resolveBgmTrack,
  type BgmStyle,
} from '../src/render/bgm-library.js'
import { BGM_PROMPTS, callTool, downloadChatCutAsset } from '../src/render/chatcut.js'
import { probeDurationMs } from '../src/render/ffmpeg.js'

const DEFAULT_WAIT_SECONDS = 300
const POLL_INTERVAL_MS = 5_000

function argValue(flag: string): string | null {
  const prefix = `${flag}=`
  const inline = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(flag)
  if (index < 0) return null
  const next = process.argv[index + 1]
  return next && !next.startsWith('--') ? next : null
}

const CONFIRMED = process.argv.includes('--yes')
const LIST_ONLY = process.argv.includes('--list')
/** 默认「只补缺口」：已存在的风格直接跳过 —— 生成是**花额度**的，`--style=ALL` 不该重造已有的曲子 */
const FORCE = process.argv.includes('--force')

function fail(message: string): never {
  console.log(`✗ ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

function pickString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const raw = value[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return undefined
}

/**
 * 从 `track_progress` 的返回里取生成产物的 asset id。
 *
 * ★ 判据必须是「拿到 id」而不是「状态看起来完了」—— `chatcut-driver.ts` 里
 *   为此写过一段很长的实测注释：processing 期间 `ok:true` / `success:true` 就已经为 true，
 *   而 `outputAssetId` **只在终态出现**。照抄状态字段会被判成「已完成 → 取不到 id」，
 *   也就是**静默丢配乐**。这里沿用同一条判据。
 */
function assetIdFromGeneration(value: Record<string, unknown>): string | undefined {
  const top = pickString(value, 'outputAssetId', 'output_asset_id')
  if (top) return top
  const entries = value.entries
  if (!Array.isArray(entries)) return undefined
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const direct = pickString(entry as Record<string, unknown>, 'outputAssetId', 'output_asset_id', 'assetId', 'asset_id')
    if (direct) return direct
  }
  return undefined
}

/** 人话形态兜底：有的工具回的是给模型看的文本，里面直接写着 `assetId: xxx` */
function assetIdFromText(value: Record<string, unknown>): string | undefined {
  const text = typeof value.message === 'string' ? value.message : JSON.stringify(value)
  const match = text.match(/"?output_?asset_?id"?\s*[:=]\s*"?([A-Za-z0-9_-]{8,})"?/i)
  return match?.[1]
}

async function createLibraryProject(): Promise<string> {
  const value = await callTool('create_project', {
    name: 'dashuai-bgm-library',
    // 配乐素材用不上画布，但 create_project 的默认画布是 1920x1080 ⇒ 显式给竖屏，
    // 万一以后拿这个项目做别的事也不会横过来（与 chatcut-driver 的约定一致）
    compositionWidth: 1080,
    compositionHeight: 1920,
    fps: 30,
    description: '大帅餐饮配乐曲库（由 bgm:generate 维护，勿手工删素材）',
  })
  const projectId = pickString(value, 'projectId', 'project_id', 'id')
  if (!projectId) fail(`ChatCut create_project 未返回 projectId：${JSON.stringify(value).slice(0, 400)}`)
  console.log(`  ✓ 已新建曲库项目 projectId=${projectId}`)
  return projectId
}

async function ensureProject(): Promise<string> {
  const explicit = argValue('--project') ?? process.env.CHATCUT_BGM_PROJECT_ID?.trim()
  if (explicit) {
    console.log(`  · 使用指定项目 projectId=${explicit}`)
    return explicit
  }
  return createLibraryProject()
}

/** 等生成就绪，拿 asset id。返回 null = 超预算放弃（不抛错，由调用方决定） */
async function waitForAssetId(projectId: string, jobId: string, budgetMs: number): Promise<string | null> {
  const startedAt = Date.now()
  for (;;) {
    const value = await callTool('track_progress', {
      action: 'status',
      target: 'generation',
      jobIds: jobId,
      projectId,
    })
    const assetId = assetIdFromGeneration(value) ?? assetIdFromText(value)
    if (assetId) return assetId

    const waited = Date.now() - startedAt
    if (waited >= budgetMs) {
      console.log(`  ✗ 等待超过 ${Math.round(budgetMs / 1000)}s 仍未取到 assetId`)
      console.log(`    最后一次返回：${JSON.stringify(value).slice(0, 600)}`)
      return null
    }
    console.log(`  · 生成中… 已等 ${Math.round(waited / 1000)}s`)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

/** 取回素材的下载地址。`request_asset_download` 回的是给人用的**鉴权**下载链接。 */
async function requestDownloadUrl(projectId: string, assetId: string): Promise<string> {
  const args: Record<string, unknown> = { assetId, variant: 'source' }
  // projectId 可选：给了更稳（外部 MCP 会话未 target 到该项目时全靠它定位）
  if (projectId) args.projectId = projectId
  const value = await callTool('request_asset_download', args)
  const direct = pickString(value, 'downloadUrl', 'download_url', 'url', 'path')
  if (direct) return direct
  const text = typeof value.message === 'string' ? value.message : JSON.stringify(value)
  const match = text.match(/https?:\/\/[^\s"')]+/)
  if (match) return match[0]
  fail(`request_asset_download 未返回下载地址：${JSON.stringify(value).slice(0, 600)}`)
}

/**
 * 由 Content-Type 定扩展名。
 *
 * ★ 不按 URL 后缀猜：导出走的是签名地址，路径里往往没有扩展名；而 Content-Type
 *   两种取法（直连下载 / 导出下载）都拿得到。
 * ★ 拿不到时落到 `.mp3` —— 曲库是按**扩展名白名单**找文件的（`bgm-library.ts`），
 *   写一个不在白名单里的名字，等于「下回来了但渲染取不到」，那是最难查的一种。
 */
function extensionFromContentType(contentType: string | null): string {
  const value = contentType?.toLowerCase() ?? ''
  if (value.includes('wav')) return '.wav'
  if (value.includes('ogg')) return '.ogg'
  if (value.includes('flac')) return '.flac'
  if (value.includes('aac') || value.includes('mp4') || value.includes('m4a')) return '.m4a'
  return '.mp3'
}

/**
 * 读素材时长 —— 排轨要它：`submit_export` 是按**帧**导出，`durationInFrames` 必须显式给。
 * ★ `inspect_asset` 只读，且返回里的 `durationMs` 是实测值（本轮实测 155110ms）。
 */
async function readAssetDurationMs(projectId: string, assetId: string): Promise<number> {
  try {
    const value = embeddedJson(await callTool('inspect_asset', { assetId, projectId }))
    const asset = value.asset && typeof value.asset === 'object' ? (value.asset as Record<string, unknown>) : value
    const raw = asset.durationMs
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw)
  } catch (error) {
    console.log(`  · 读素材时长失败（${(error as Error).message.slice(0, 100)}）⇒ 按 120s 保守铺轨`)
  }
  return 120_000
}

/**
 * 从返回体里抠出**嵌在文本中的 JSON 对象**。ChatCut 的工具常回「JSON 正文 + 一段人话」
 * （例如 `edit_track create` 会在 JSON 后面追加一行 `Caption notice: …`），
 * 这时 `extractStructured()` 的 `JSON.parse(整段)` 必然失败。这条经验来自
 * `chatcut-driver.ts::parseEmbeddedJson`（那边为此踩过一次「建轨成功却取不到轨道 id」）。
 */
function embeddedJson(value: Record<string, unknown>): Record<string, unknown> {
  const text = typeof value.message === 'string' ? value.message : ''
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // 抠不出来就退回原值
    }
  }
  return value
}

/** 从 `submit_export` 的返回里取 renderId（结构化优先，其次从人话里正则兜底） */
function renderIdsOf(value: Record<string, unknown>): string[] {
  const source = embeddedJson(value)
  for (const key of ['renderIds', 'renders', 'ids', 'items', 'entries']) {
    const list = source[key]
    if (!Array.isArray(list)) continue
    const ids = list.flatMap((item) => {
      if (typeof item === 'string') return [item]
      if (item && typeof item === 'object') {
        const id = pickString(item as Record<string, unknown>, 'renderId', 'id')
        return id ? [id] : []
      }
      return []
    })
    if (ids.length > 0) return ids
  }
  const text = typeof value.message === 'string' ? value.message : JSON.stringify(value)
  const match = text.match(/render_?id"?\s*[:=]\s*"?([A-Za-z0-9_-]{6,})"?/i)
  return match?.[1] ? [match[1]] : []
}

/** 从 `track_export` 的返回里取公开下载地址（沿用 driver 里那套「结构化优先 + 正则兜底」） */
function downloadUrlOf(value: Record<string, unknown>): string | null {
  const source = embeddedJson(value)
  const direct = pickString(source, 'downloadUrl', 'download_url', 'url')
  if (direct) return direct
  const entries = source.entries
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (entry && typeof entry === 'object') {
        const url = pickString(entry as Record<string, unknown>, 'downloadUrl', 'download_url', 'url')
        if (url) return url
      }
    }
  }
  const text = typeof value.message === 'string' ? value.message : JSON.stringify(value)
  return text.match(/https?:\/\/[^\s"')]+/)?.[0] ?? null
}

const FACTORY_TRACK_NAME = 'BGM-FACTORY'

/**
 * 找出某条音轨上**已经排着的** item id。
 *
 * ★ 为什么需要它（实测踩过）：`exportAssetAudio` 复用同一条 `BGM-FACTORY` 轨，
 *   而 `submit_export` 导的是**整条时间线**；上一次导出留下的 item 会一直躺在 0 帧上，
 *   于是下一次 `edit_item {adds:[{fromFrame:0}]}` 直接撞重叠 ——
 *   报错原文：`adds[0]: Overlap: new item at 0.0s would overlap existing audio item
 *   c071106498 at 0.0s-155.1s on this track.`
 *   （UPBEAT / PREMIUM 两首因此「生成成功却落不了盘」，白花了一次生成额度。）
 * ★ item id 拿不到的地方：`edit_track action:'list'` **只回轨道**，实测字段就是
 *   `{audioRouting,hidden,id,muted,name,order,role,trackType}` 八项，**不含 item**。
 *   唯一来源是 `preview_timeline` 的 `timeline.entries[]`：条目 `kind==='item'` 时
 *   才有 `id`。上面报错里的 `c071106498` 正是某条 item id 去短横线后的前缀。
 * ★★ 两个位置踩的坑都不是「没有数据」，而是**判据写错后静默返回空**（最贵的一种失败）：
 *   ① 套 `embeddedJson()` 抠错了对象（见下）；② 短 id 与 uuid 做等值比较（见下）。
 *   两次都报**一模一样的**重叠错，看不出任何线索。改这类「列表恒为空」的代码时，
 *   先确认**长度**再确认内容 —— 空列表与「过滤全不中」在日志里长得一样。
 */
async function itemsOnTrack(projectId: string, trackId: string): Promise<string[]> {
  const raw = await callTool('preview_timeline', { projectId })
  // ★★ 这里**不能**套 `embeddedJson()`（第一次修复就栽在这上面，报错一字未变）：
  //   `preview_timeline` 的人话 `message` 正文里含 `audioDucking={"role":"follower"}`，
  //   于是 `indexOf('{')`/`lastIndexOf('}')` 恰好抠出 `{"role":"follower"}`、
  //   `JSON.parse` 还成功了 ⇒ 返回一个**看着正常但完全不相干**的对象，
  //   `timeline.entries` 恒为 undefined、item 列表恒为空，静默地什么都不删。
  //   `preview_timeline` 的结构化结果本来就在**顶层**（`raw.timeline`），直接读即可。
  const timeline =
    raw.timeline && typeof raw.timeline === 'object' ? (raw.timeline as Record<string, unknown>) : {}
  const entries = Array.isArray(timeline.entries) ? timeline.entries : []
  // ★★ 两边给的**不是同一种 id**，不能直接等值比：
  //   `edit_track action:'list'` 回 **10 位短 id**（实测 `feb6939b7c`），
  //   `preview_timeline` 回**完整 uuid**（实测 `feb6939b-7cbd-4647-9aec-770947916571`）。
  //   我第一版把两边去短横线后做 `!==` 比较 ⇒ 恒不相等、item 列表恒为空、
  //   静默什么都不删，报错一字未变（白跑一轮）。正确判据是**互比前缀**（谁短谁是对方的前缀）。
  const bare = trackId.replace(/-/g, '').toLowerCase()
  const ids: string[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    if (item.kind !== 'item') continue
    const onTrack = (pickString(item, 'trackId') ?? pickString(item, 'trackAlias') ?? '').replace(/-/g, '').toLowerCase()
    if (!onTrack) continue
    // 前缀互认：`edit_track list` 的短 id 与 `preview_timeline` 的 uuid 都能匹配上
    if (!onTrack.startsWith(bare) && !bare.startsWith(onTrack)) continue
    const id = pickString(item, 'id')
    if (id) ids.push(id)
  }
  return ids
}

/**
 * 把已生成的音乐素材**导出成音频文件**并取回字节。
 *
 * ★★ 为什么不走 `request_asset_download`（那个名字看起来最对）：
 *   它给的是**面向用户**的链接 —— 描述原文是 "gives the **user** an authenticated
 *   ChatCut download URL/path for their device"。实测（2026-09-24）带本适配层的
 *   OAuth `Authorization: Bearer` 去拉，回 **HTTP 401**；而同一轮里其它工具全部正常，
 *   ⇒ 那个链接认的是**浏览器会话**，不是外部 MCP 的 token。
 *   描述里提到的 `pull_asset`（"downloads bytes into the **agent sandbox**"）才是给 agent 用的，
 *   但它在**任何 surface 上都不存在**（codex/claude/chatgpt/cursor 逐个数过：59/59/60/60，
 *   差异只有 ask_followup_questions / show_preview / submit_image）。
 * ★ 所以改为**导出**：导出结果的地址是**公开签名**的 —— 生产代码
 *   `worker.ts::finishChatCutTask()` 下载成片就是裸 `fetch(resultUrl)`（同一套机制，已验证）。
 * ★ 导出前必须先把曲目**排到时间线上**：`submit_export` 导的是**时间线**，
 *   空时间线导不出东西。`durationInFrames` 必须显式给 —— 省略会按素材自身时长铺、
 *   把时间线撑长（`placeChatCutBgm` 为此写过一段实测注释）。
 */
async function exportAssetAudio(
  projectId: string,
  assetId: string,
  durationMs: number,
): Promise<{ bytes: Buffer; contentType: string | null }> {
  // 复用同名轨，避免每跑一次就往曲库项目里堆一条空轨
  const listed = await callTool('edit_track', { projectId, action: 'list' })
  const tracks = Array.isArray(listed.items) ? listed.items : []
  let trackId: string | undefined
  for (const track of tracks) {
    if (!track || typeof track !== 'object') continue
    const item = track as Record<string, unknown>
    if (pickString(item, 'name') === FACTORY_TRACK_NAME) {
      trackId = pickString(item, 'id', 'trackId')
      if (trackId) break
    }
  }
  if (trackId) {
    console.log(`  · 复用音频轨 ${FACTORY_TRACK_NAME}（${trackId}）`)
  } else {
    const created = embeddedJson(
      await callTool('edit_track', {
        projectId,
        action: 'create',
        json: JSON.stringify({ trackType: 'audio', name: FACTORY_TRACK_NAME, role: 'follower' }),
      }),
    )
    trackId = pickString(created, 'id', 'trackId')
    if (!trackId) fail(`建音频轨后未取到 trackId：${JSON.stringify(created).slice(0, 400)}`)
    console.log(`  · 新建音频轨 ${FACTORY_TRACK_NAME}（${trackId}）`)
  }

  const frames = Math.max(1, Math.round((Math.max(durationMs, 1) / 1000) * 30))
  const add = { type: 'audio', assetId, fromFrame: 0, durationInFrames: frames, trackId }
  const stale = await itemsOnTrack(projectId, trackId)
  if (stale.length === 0) {
    await callTool('edit_item', { projectId, adds: [add] })
  } else {
    console.log(
      `  · 先清掉轨上上一轮的 ${stale.length} 条 item（否则 adds 撞重叠）：${stale.map((id) => id.slice(0, 8)).join(', ')}`,
    )
    const deletes = stale.map((id) => ({ id }))
    try {
      // 首选「删旧 + 加新」同批提交：`edit_item` 的 adds/updates/deletes 是一批原子提交，
      // 任一条校验不过整批回滚（schema 原文），不会留下「删了没加」的中间态。
      await callTool('edit_item', { projectId, deletes, adds: [add] })
    } catch (error) {
      // 万一对方的重叠校验是拿**编辑前**的状态算的，同批提交就会被误判 ⇒ 退化成两步。
      // 两步唯一代价是中间有一瞬轨是空的，而这条 `BGM-FACTORY` 轨只有本脚本会用，无并发读者。
      console.log(`  · 删+加同批提交未通过（${(error as Error).message.slice(0, 140)}）⇒ 改为先删后加`)
      await callTool('edit_item', { projectId, deletes })
      await callTool('edit_item', { projectId, adds: [add] })
    }
  }

  const submitted = await callTool('submit_export', { projectId, format: 'audio' })
  const renderIds = renderIdsOf(submitted)
  if (renderIds.length === 0) fail(`submit_export 未返回 renderId：${JSON.stringify(submitted).slice(0, 500)}`)
  console.log(`  · 已提交音频导出 renderId=${renderIds.join(',')}`)

  const startedAt = Date.now()
  for (;;) {
    const value = await callTool('track_export', { projectId, action: 'wait', renderIds: renderIds.join(',') })
    const url = downloadUrlOf(value)
    if (url) {
      const response = await fetch(url, { signal: AbortSignal.timeout(180_000) })
      if (!response.ok) fail(`导出文件下载失败 HTTP ${response.status}`)
      return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') }
    }
    if (Date.now() - startedAt >= 240_000) {
      fail(`等待音频导出超过 240s：${JSON.stringify(value).slice(0, 500)}`)
    }
    console.log(`  · 导出中… 已等 ${Math.round((Date.now() - startedAt) / 1000)}s`)
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

/**
 * 取回素材字节：先试「直连下载」，失败再走「导出音频」。
 *
 * ★ 保留直连那一步是为了留痕：它一旦开始工作（ChatCut 放开或换成会话鉴权），
 *   日志里会直接显示成功，不用回来改代码；而失败原因是**确定性的 401**，
 *   多花一次请求没有代价。
 */
async function fetchAssetBytes(
  projectId: string,
  assetId: string,
  durationMs: number,
): Promise<{ bytes: Buffer; contentType: string | null; via: string }> {
  try {
    const url = await requestDownloadUrl(projectId, assetId)
    const down = await downloadChatCutAsset(url)
    console.log('  · 直连下载成功（request_asset_download）')
    return { ...down, via: 'request_asset_download' }
  } catch (error) {
    console.log(`  · 直连下载不可用（${(error as Error).message.slice(0, 120)}）⇒ 改走导出音频`)
  }
  const exported = await exportAssetAudio(projectId, assetId, durationMs)
  return { ...exported, via: 'submit_export:audio' }
}

async function ingest(
  style: BgmStyle,
  projectId: string,
  waitSeconds: number,
  presetAssetId: string | null,
): Promise<boolean> {
  const prompt = BGM_PROMPTS[style]
  console.log(`\n── ${style} ─────────────────────────────────────────────`)
  console.log(`  prompt: ${prompt}`)

  if (!CONFIRMED) {
    console.log('  （dry-run）将执行：')
    if (presetAssetId) {
      console.log(`    跳过生成，直接取已有素材 assetId=${presetAssetId}`)
      console.log('    → request_asset_download → 落盘（**不消耗生成额度**）')
    } else {
      console.log(`    submit_music generationType=instrumental name=dashuai-bgm-${style} projectId=${projectId}`)
      console.log('    → track_progress 轮询 → request_asset_download → 落盘')
      console.log('  ⚠ 这一步**消耗 ChatCut 额度**。确认无误后加 --yes 再跑一次。')
    }
    return false
  }

  let assetId = presetAssetId
  if (assetId) {
    // ★ 生成已经成功了、只是当时没取回来（例如下载那一步报错）时走这条路：
    //   绝不为「同一首曲子」再花一次生成额度。
    console.log(`  · 跳过生成，直接取已有素材 assetId=${assetId}`)
  } else {
    const job = await callTool('submit_music', {
      generationType: 'instrumental',
      prompt,
      name: `dashuai-bgm-${style}`,
      projectId,
    })
    const jobId =
      pickString(job, 'jobId', 'job_id', 'id') ??
      (typeof job.message === 'string'
        ? job.message.match(/job_?id"?\s*[:=]\s*"?([A-Za-z0-9_-]{6,})"?/i)?.[1]
        : undefined)
    if (!jobId) fail(`submit_music 未返回 jobId：${JSON.stringify(job).slice(0, 600)}`)
    console.log(`  ✓ 已提交生成 jobId=${jobId}`)

    const ready = await waitForAssetId(projectId, jobId, waitSeconds * 1000)
    if (!ready) {
      console.log(`  ✗ ${style} 未取到素材，跳过（不写盘）`)
      return false
    }
    assetId = ready
    console.log(`  ✓ 生成就绪 assetId=${assetId}`)
  }

  const assetMs = await readAssetDurationMs(projectId, assetId)
  const { bytes, contentType, via } = await fetchAssetBytes(projectId, assetId, assetMs)
  if (bytes.byteLength < 64 * 1024) fail(`下载到的文件只有 ${bytes.byteLength} 字节，明显不是一首曲子`)
  console.log(`  ✓ 已取回 ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB（来源：${via}）`)

  const dir = bgmLibraryDir()
  mkdirSync(dir, { recursive: true })
  const extension = extensionFromContentType(contentType)
  const target = join(dir, `${style}${extension}`)

  // 同风格若有别的扩展名残留，先删掉，避免「按扩展名优先级取到旧文件」这种诡异现象
  const stale = resolveBgmTrack(style)
  if (stale && stale !== target && existsSync(stale)) {
    rmSync(stale, { force: true })
    console.log(`  · 清掉旧的 ${stale}`)
  }

  writeFileSync(target, bytes)
  const durationMs = await probeDurationMs(target).catch(() => null)
  writeFileSync(
    bgmMetadataPath(target),
    `${JSON.stringify(
      {
        style,
        source: `chatcut:${via}`,
        model: 'mureka-9',
        prompt,
        generatedAt: new Date().toISOString(),
        chatcutProjectId: projectId,
        chatcutAssetId: assetId,
        bytes: bytes.byteLength,
        durationMs,
        license:
          '由 ChatCut（mureka-9）生成，授权以 ChatCut 服务条款为准 —— 商用前请核对当期条款并留档',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`  ✓ 已落盘 ${target}（${(bytes.byteLength / 1024 / 1024).toFixed(2)} MB，时长 ${((durationMs ?? 0) / 1000).toFixed(1)}s）`)
  return true
}

async function main(): Promise<void> {
  const before = describeBgmLibrary()
  console.log('大帅餐饮配乐曲库')
  console.log(`曲库目录：${before.dir}${before.dirExists ? '' : '（尚未创建）'}`)
  for (const entry of before.entries) {
    console.log(`  ${entry.style.padEnd(8)} ${entry.file ?? '（缺，渲染时会回退到合成垫底）'}`)
    if (entry.note) console.log(`${' '.repeat(11)}${entry.note}`)
  }

  const requested = (argValue('--style') ?? '').trim().toUpperCase()
  if (LIST_ONLY || !requested) {
    if (!requested && !LIST_ONLY) {
      console.log('\n用法：--style=LIGHT|UPBEAT|PREMIUM|ALL [--yes] [--force] [--project=<id>] [--asset=<assetId>] [--wait=<秒>] [--list]')
      console.log('默认 dry-run：只打印将发送的请求；加 --yes 才真调用（会消耗 ChatCut 额度）。')
      console.log('默认只补缺口：已有曲子的风格会跳过，--force 才重生成。')
      console.log('--asset=<assetId>：跳过生成、只把**已经生成好**的素材取回落盘（不花生成额度）。')
    }
    return
  }

  const styles: BgmStyle[] = requested === 'ALL' ? [...BGM_STYLES] : [requested as BgmStyle]
  for (const style of styles) {
    if (!(BGM_STYLES as readonly string[]).includes(style)) {
      fail(`未知风格 ${style}，可选：${BGM_STYLES.join(' / ')} / ALL`)
    }
  }

  const presetAssetId = (argValue('--asset') ?? '').trim() || null
  let projectId = argValue('--project') ?? process.env.CHATCUT_BGM_PROJECT_ID?.trim() ?? ''
  if (!CONFIRMED) {
    projectId ||= presetAssetId ? '<沿用素材所在项目>' : '<将新建 dashuai-bgm-library>'
  } else if (!projectId && !presetAssetId) {
    // ★ 只有**要生成**的时候才建项目：带 --asset 时素材已经在某个项目里了，
    //   这时再建一个新项目纯属制造垃圾。
    projectId = await ensureProject()
  }

  const waitSeconds = Number(argValue('--wait') ?? DEFAULT_WAIT_SECONDS)
  const budget = Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds : DEFAULT_WAIT_SECONDS

  let ok = 0
  for (const style of styles) {
    // 默认只补缺口：已存在的风格跳过，避免 --style=ALL 把已有曲子重造一遍（生成花额度）
    const existing = resolveBgmTrack(style)
    if (existing && !FORCE) {
      console.log(`\n── ${style} ─────────────────────────────────────────────`)
      console.log(`  · 已有曲子，跳过：${existing}（要重生成加 --force）`)
      ok += 1
      continue
    }
    try {
      if (await ingest(style, projectId, budget, presetAssetId)) ok += 1
    } catch (error) {
      // 单个风格失败不该中断其余风格：补曲库是运维动作，跑一次能补几个是几个
      console.log(`  ✗ ${style} 失败：${(error as Error).message}`)
    }
  }

  if (CONFIRMED) {
    console.log(`\n完成：本次成功落盘 ${ok}/${styles.length}`)
    const after = describeBgmLibrary()
    for (const entry of after.entries) {
      console.log(`  ${entry.style.padEnd(8)} ${entry.file ?? '（缺）'}`)
    }
  }
}

main()
  .catch((error: unknown) => {
    if (process.exitCode !== 1) console.error(`脚本异常：${(error as Error).message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined)
    redis.disconnect()
    process.exit(process.exitCode ?? 0)
  })
