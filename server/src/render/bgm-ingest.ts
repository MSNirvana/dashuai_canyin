/**
 * 配乐「生成 → 落盘」执行层 —— 两个补货 CLI 共用（`bgm:generate` / `bgm:replenish`）。
 *
 * ★ 为什么单独成模块：这两个 CLI 要做的是**同一件事** —— 从某个生成源拿一首曲子、
 *   校验时长、落进本地曲库（池子或单文件）、写元数据。这段逻辑原先只存在于
 *   `scripts/bgm-generate.ts`，并且直接读 `process.argv`（`CONFIRMED` / `INTO_POOL`）。
 *   第二个 CLI 一旦共用它，就会依赖「两个脚本的 argv 恰好同义」这种**隐式耦合** ——
 *   那正是下一步事故的温床（谁改了其中一个脚本的参数名，另一个静默变行为）。
 *   所以这里把 argv 依赖全部改成**显式入参**（`BgmIngestOptions`）。
 *
 * ★★ 两个生成源：
 *   ① `ingestChatcutBgm`：ChatCut `submit_music`（mureka-9）。
 *      取回素材**不走** `request_asset_download`（它给的是面向浏览器的鉴权链接，
 *      外部 MCP token 去拉回 401），而是走 `exportAssetAudio` 的**导出**通道 —— 详见该函数注释。
 *   ② `ingestVolcanoBgm`：火山 `GenBGMForTime`（豆包音乐 v5.0）→ 轮询 `QuerySong`
 *      → 下载 `SongDetail.AudioUrl`。需要 AK/SK，见 `volcano-bgm.ts`。
 *
 * ★★ 共同硬约束（改这里之前先读这三条）：
 *   · **时长必须 ≥65s**（`BGM_MIN_DURATION_MS`）：`synthesis.ts::mixAudioTracks()` 用
 *     `amix=duration=longest` 且**不循环**，比成片短的曲子会在中途静音，且**没有任何报错**。
 *   · **落盘位置由 `options.intoPool` 决定，池子与单文件互不覆盖**：
 *     池子 = `assets/bgm/<风格>/<风格>-<时间戳>.<ext>`（多条），
 *     单文件 = `assets/bgm/<风格>.<ext>`（老的约定，线上现存曲库）。
 *     ⚠ 清理「同风格单文件残留」必须用 `singleFileBgmTrack`（**不看池子**），
 *     否则池子非空时会删掉刚攒进去的曲子（补一首删一首）。
 *   · **等待类失败返回 `false` 而不抛**（超预算、取不到素材 ⇒ 由调用方决定算不算失败），
 *     但**确定性错误直接抛**（字节数明显不是曲子、时长不达标、导出失败）——
 *     静默落盘一个坏文件，比当场失败贵得多。
 *
 * ★★ 联网只发生在**补货**时（运维动作）。渲染管线只读本地文件（`bgm-library.ts`），
 *   所以第三方挂了或额度耗尽只是「不能补曲库」，**不会让出片失败**。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BGM_MIN_DURATION_MS,
  bgmLibraryDir,
  bgmMetadataPath,
  bgmPoolDir,
  listBgmPool,
  singleFileBgmTrack,
  type BgmStyle,
} from './bgm-library.js'
import { BGM_PROMPTS, callTool, downloadChatCutAsset } from './chatcut.js'
import { probeDurationMs } from './ffmpeg.js'
import {
  describeVolcanoBgmConfig,
  generateVolcanoBgm,
  pickVolcanoPrompt,
  volcanoDurationForStyle,
} from './volcano-bgm.js'

const POLL_INTERVAL_MS = 5_000

/**
 * 一次补货的参数。**刻意做成显式对象**（而不是读 `process.argv`）：
 * 同一份逻辑要被两个 CLI 调用，argv 只有一份，读 argv 就等于两个 CLI 共享隐式状态。
 */
export interface BgmIngestOptions {
  /** true = 真调用第三方；false = 只打印将发送的请求（dry-run，不花额度） */
  confirmed: boolean
  /** 落盘位置：true = 池子 `assets/bgm/<风格>/`；false = 单文件 `assets/bgm/<风格>.<ext>` */
  intoPool: boolean
  /** 等待生成就绪的预算（秒）。缺省 300。 */
  waitSeconds?: number
  /** ChatCut 项目 id（仅 chatcut 源）。缺省时按 `CHATCUT_BGM_PROJECT_ID` 取，都没有则新建。 */
  projectId?: string | null
  /** 已生成好的 ChatCut 素材 id（仅 chatcut 源）：给了就跳过生成、只取回落盘（不花生成额度） */
  presetAssetId?: string | null
  /**
   * 火山提示词的**固定序号**（仅 volcano 源）。给了就按 `序号 % 提示词条数` 取，
   * 不给则随机取一条。
   *
   * ★★ 补货脚本**必须**给这个值：随机取词在一轮里会撞（同一风格两首用同一条描述 ⇒
   *   池子里出现近乎重复的曲子，「曲库要大要多」就落空了）。补货按**池内现有数量 + 本次第几首**
   *   顺序取词，既保证一轮内不撞，跨轮也会轮转。
   * ⚠ 提示词表只有 3 条/风格（`VOLCANO_BGM_PROMPTS`），池子超过 3 首**必然**开始重复 ——
   *   要真正「多」，得往那个表里加词条，而不是调这里。
   */
  promptIndex?: number
}

const DEFAULT_WAIT_SECONDS = 300

export function fail(message: string): never {
  console.log(`✗ ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

export function pickString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
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
export function assetIdFromGeneration(value: Record<string, unknown>): string | undefined {
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
export function assetIdFromText(value: Record<string, unknown>): string | undefined {
  const text = typeof value.message === 'string' ? value.message : JSON.stringify(value)
  const match = text.match(/"?output_?asset_?id"?\s*[:=]\s*"?([A-Za-z0-9_-]{8,})"?/i)
  return match?.[1]
}

export async function createLibraryProject(): Promise<string> {
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

export async function ensureChatcutBgmProject(explicitProjectId?: string | null): Promise<string> {
  const explicit = explicitProjectId?.trim() || process.env.CHATCUT_BGM_PROJECT_ID?.trim()
  if (explicit) {
    console.log(`  · 使用指定项目 projectId=${explicit}`)
    return explicit
  }
  return createLibraryProject()
}

/** 等生成就绪，拿 asset id。返回 null = 超预算放弃（不抛错，由调用方决定） */
export async function waitForAssetId(projectId: string, jobId: string, budgetMs: number): Promise<string | null> {
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
export async function requestDownloadUrl(projectId: string, assetId: string): Promise<string> {
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
export function extensionFromContentType(contentType: string | null): string {
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
export async function readAssetDurationMs(projectId: string, assetId: string): Promise<number> {
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
export function embeddedJson(value: Record<string, unknown>): Record<string, unknown> {
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
export function renderIdsOf(value: Record<string, unknown>): string[] {
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
export function downloadUrlOf(value: Record<string, unknown>): string | null {
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
export async function itemsOnTrack(projectId: string, trackId: string): Promise<string[]> {
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
export async function exportAssetAudio(
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
export async function fetchAssetBytes(
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

export async function ingestChatcutBgm(style: BgmStyle, options: BgmIngestOptions): Promise<boolean> {
  const projectId = options.projectId ?? ''
  const waitSeconds = options.waitSeconds ?? DEFAULT_WAIT_SECONDS
  const presetAssetId = options.presetAssetId ?? null
  const prompt = BGM_PROMPTS[style]
  console.log(`\n── ${style} ─────────────────────────────────────────────`)
  console.log(`  prompt: ${prompt}`)

  if (!options.confirmed) {
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

  // ★★ 落盘位置由 `options.intoPool` 决定（见 BgmIngestOptions.intoPool）：
  //   默认（chatcut 不带 --pool）写老的**单文件** `assets/bgm/<风格>.<扩展名>` —— 与改动前逐字节一致；
  //   带 `--pool` 时写**池子** `assets/bgm/<风格>/<风格>-<时间戳>.<扩展名>`。
  //   两个位置互不覆盖，所以「换生成源」不会毁掉现有曲库。
  const extension = extensionFromContentType(contentType)
  const dir = options.intoPool ? bgmPoolDir(style) : bgmLibraryDir()
  mkdirSync(dir, { recursive: true })
  const target = options.intoPool ? join(dir, `${style}-${Date.now()}${extension}`) : join(dir, `${style}${extension}`)

  // 同风格若有别的扩展名残留，先删掉，避免「按扩展名优先级取到旧文件」这种诡异现象。
  // ★★ 只在**单文件**模式下做，而且必须用 `singleFileBgmTrack`（**不看池子**）：
  //   池子模式下 `resolveBgmTrack` 会返回池内随机一首，拿它当「残留」删掉 = 删自己刚攒的曲子。
  //   「找单文件」与「找一个能用的曲子」是两件事，不能共用 `resolveBgmTrack`。
  if (!options.intoPool) {
    const stale = singleFileBgmTrack(style)
    if (stale && stale !== target && existsSync(stale)) {
      rmSync(stale, { force: true })
      console.log(`  · 清掉旧的 ${stale}`)
    }
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

/**
 * 火山生成源：提交 → 轮询 → 下载 → 落进**池子**。
 *
 * ★ 与 `ingest()`（ChatCut 源）的三点不同：
 *   ① 描述用**中文**并按风格**随机取一条** —— 该接口 `Text` 仅支持中文，
 *      且随机取条才能让池子里的曲子有差异（同风格多条才不会千篇一律）；
 *   ② 时长取满 120s（v5.0 上限）：既满足「≥65s」硬约束，也**降低触发版权校验**的概率
 *      （文档原话：入参简单的短音乐容易触发 code 50000001）；
 *   ③ 落在 `assets/bgm/<风格>/` 而不是单文件 —— **不会覆盖**现有曲子。
 */
export async function ingestVolcanoBgm(style: BgmStyle, options: BgmIngestOptions): Promise<boolean> {
  const waitSeconds = options.waitSeconds ?? DEFAULT_WAIT_SECONDS
  // ★ 给了 promptIndex 就顺序取词（补货脚本用，避免一轮内撞词），否则随机
  const prompt = options.promptIndex === undefined ? pickVolcanoPrompt(style) : pickVolcanoPrompt(style, options.promptIndex)
  const durationSec = volcanoDurationForStyle(style)
  console.log(`\n── ${style}（火山 GenBGM）─────────────────────────────`)
  console.log(`  text: ${prompt}`)
  console.log(`  duration: ${durationSec}s`)

  if (!options.confirmed) {
    console.log('  （dry-run）将执行：')
    console.log('    POST https://open.volcengineapi.com/?Action=GenBGMForTime&Version=2024-08-12')
    console.log(`      Body: { "Text": "<上面的中文描述>", "Duration": ${durationSec}, "Version": "v5.0" }`)
    console.log('    → 轮询 QuerySong（不额外计费）直到 Status=2 → 下载 SongDetail.AudioUrl → 落进池子')
    console.log(`  ⚠ 每首按秒计费（约 0.002 元/秒 ⇒ 本次约 ${(durationSec * 0.002).toFixed(2)} 元）。确认无误后加 --yes。`)
    return false
  }

  const config = describeVolcanoBgmConfig()
  if (!config.configured) {
    fail(
      `未配置火山 AK/SK：缺 ${config.missing.join(' / ')}` +
        `（控制台右上角账号 → 密钥管理 → 新建密钥；建议用子账户的 AK/SK。` +
        `注意这与火山 TTS 的 X-Api-Key 不是同一套凭证）`,
    )
  }

  const generated = await generateVolcanoBgm({
    text: prompt,
    durationSec,
    waitSeconds,
    onProgress: (note) => console.log(`  · ${note}`),
  })

  const dir = bgmPoolDir(style)
  mkdirSync(dir, { recursive: true })
  const target = join(dir, `${style}-${Date.now()}${extensionFromContentType(generated.contentType)}`)
  writeFileSync(target, generated.bytes)
  const durationMs =
    (await probeDurationMs(target).catch(() => null)) ??
    (generated.durationSec ? Math.round(generated.durationSec * 1000) : null)

  // ★ ≥65s 是硬约束：曲子比成片短会**中途静音且不报错**（synthesis 的 amix 不循环、无告警）。
  //   宁可当场丢弃并报错，也不要让它静默进池子 —— 那是「配乐莫名其妙消失」的成因。
  if (durationMs !== null && durationMs < BGM_MIN_DURATION_MS) {
    rmSync(target, { force: true })
    fail(
      `${style} 生成的曲子只有 ${(durationMs / 1000).toFixed(1)}s，低于 65s 硬约束，已丢弃` +
        `（重试时请加长 Duration / 丰富 Text）`,
    )
  }

  writeFileSync(
    bgmMetadataPath(target),
    `${JSON.stringify(
      {
        style,
        source: 'volcano:GenBGMForTime',
        model: 'doubao-music-v5.0',
        prompt,
        generatedAt: new Date().toISOString(),
        volcanoTaskId: generated.taskId,
        audioUrl: generated.audioUrl,
        bytes: generated.bytes.byteLength,
        durationMs,
        license:
          '由火山引擎 AI 音乐生成大模型（豆包音乐）生成；生成物的商用权限以火山引擎当期服务条款为准 —— 商用前请核对并留档',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(
    `  ✓ 已落进池子 ${target}（${(generated.bytes.byteLength / 1024 / 1024).toFixed(2)} MB，时长 ${((durationMs ?? 0) / 1000).toFixed(1)}s）`,
  )
  console.log(`  · ${style} 池子现在共 ${listBgmPool(style).length} 首`)
  return true
}
