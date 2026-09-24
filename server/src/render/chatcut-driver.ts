/**
 * ChatCut 真实适配层 —— 「多步驱动云端编辑器」而不是「提交一个 job」。
 *
 * ⚠ 为什么必须重写：原 `submitChatCutJob()` 假设存在一个「吃下整片配置、吐出一个 jobId」的
 * 作业式接口，并按此发了 10 个字段（idempotencyKey/projectName/render/voice/captions/audio/
 * editing/clips）。实测 `tools/list` 返回的 59 个工具**全是编辑器操作原语**，
 * 一个都不认这些字段（probe ⑥⑦ 节有对照），所以那条路从来就没通过。
 *
 * 真实可用路径（本文件实现的部分）：
 *   1. create_project                      → projectId / timelineId / trackIds
 *   2. import_media  action=create_session → endpoint + token（一次性上传会话）
 *      └ 每个素材：register_asset_placeholder → prepare_registered_upload
 *                  → PUT 字节到 presignedUrl → finalize_asset_upload
 *   3. edit_item  adds                     → 把素材排上轨道（帧原生）
 *   4. edit_track                          → role=anchor/follower（引擎自动闪避，不用手调音量）
 *   5. edit_captions enable                → 字幕（从转录派生，不是烧 SRT）
 *   6. submit_export → track_export        → renderId → downloadUrl
 *
 * ★ 素材上传是「预签名 PUT 原始字节」，不要求本地文件路径 ——
 *   官方 `upload-media.mjs` 要路径只是因为它是个 CLI；协议本身只认
 *   Content-Length + Content-Type + bytes。所以服务端可以从 COS 直接流式转发，
 *   这也是「这项适配能否在无头服务端跑通」的命门，已实测通过。
 *
 * ★ 上传助手另外做的本地预处理（ffmpeg 转码/抽缩略图探测响度/抽转录音轨）
 *   不是协议要求，是它为了「不知道上游素材长什么样」而做的自我保护。
 *   我们只做「声明正确的元数据」，不需要那套预处理 ——
 *   ⚠ 但「正确」是硬要求：这条管道推的是**原始素材**（不是本地管线那份 9:16 归一化产物），
 *     所以宽高必须真去探。缺 width/height 时它直接回 400
 *     `helper import registration for video requires complete metadata so the backend
 *      does not process large files locally` —— 声明错的尺寸比不声明更糟，
 *     拿画布尺寸凑数会让云端按错误比例处理（见 remoteSource）。
 *
 * ★★ 上面这段「推的是原始素材」自 2026-09-22 起**分成了两条路线**（AI 档的「素材处理」选项）：
 *   · `clipPrep: 'ORIGINAL'`（**默认**）：就是本段描述的情形 —— 原子节直传、宽高真去探；
 *   · `clipPrep: 'NORMALIZED'`：worker 已先本地归一化，推上来的**本身就是 1080×1920**，
 *     宽高探出来必然等于画布尺寸（这正是那条路线要的效果，不是「拿画布尺寸凑数」的旧毛病）。
 *   ⇒ 读到这里时别把两种情形混起来判：判断依据看 `worker.ts::prepClipLocally` 是否被走过。
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { withTransientRetry } from '../lib/transient-retry.js'
import { generateEditPlan } from './edit-plan.service.js'
import { toEdlShotMs } from './edl.js'
import {
  callTool,
  CHATCUT_VOICE_OFF,
  // 以下四张表是「面板档位 → 真实原语」的唯一来源，定义在 chatcut.ts（见那里的注释）。
  // ★ 绝不在这里再抄一份：抄两份就必然会出现「改了一处、另一处还是旧值」的静默失效。
  CAPTION_PRESETS,
  TRANSITION_PLANS,
  PACING_PLANS,
  BGM_PROMPTS,
  type ChatCutJobInput,
  type ChatCutOptions,
} from './chatcut.js'
import { framesOf, planShotTiming } from './chatcut-timing.js'
import { prisma } from '../db.js'
import { activeTtsProvider } from '../services/tts-provider.service.js'
import { synthesizeNarration } from './tts.js'
import { probeClipMeta, probeDurationMs, probeLoudnessLufs, probeSpeechEndMs, retimeAudioTo, MAX_SPEECH_TEMPO } from './ffmpeg.js'

/** 一个上传会话最多导 4 个素材（官方助手的硬限制），超了要重开会话 */
const SESSION_BATCH_SIZE = 4
const MULTIPART_SIGN_BATCH_SIZE = 100
const IMPORT_ATTEMPT_TIMEOUT_MS = Number(process.env.CHATCUT_IMPORT_TIMEOUT_MS ?? 120_000)

/**
 * ★★ 启动阶段（建项目 → 探素材 → TTS → 上传全部字节 → 排轨）里每一次网络往返都要带瞬断重试。
 *
 * 为什么这里必须有、而别处没有（2026-09-22 任务 12 的实证）：
 *   链路会偶发 `TypeError: terminated`（对端把连接掐了）。它在**轮询**阶段不致命 ——
 *   worker 那边有 `查询失败（第 1/40 次）` 兜着（任务 11 就是靠它活下来的）。
 *   但**启动阶段是一次性调用、外面没有任何重试** ⇒ 上传 12 个素材的路上
 *   任何一次瞬断都会让整条任务 FAILED、用户白等 4 分钟并损失积分。
 *   任务 12 就是这么死的：`素材 shot-6.mp4 导入失败：fetch failed（TypeError: terminated）`。
 *
 * ★ 重试是**幂等**的，这一点由三处独立事实保证（不是这里新加的前提）：
 *   ① `requestIdFor()` —— 同一请求体算出同一 requestId，服务端按它去重；
 *   ② `ChatCutUploadSource.open()` —— 接口注释写明「每次调用都要返回一个**新**流：PUT 重试会重读」；
 *   ③ 预签名 PUT 本身按 key 覆盖写，重复推同一份字节无害。
 *
 * 具体策略（次数 / 退避 / 什么算瞬断）见 `src/lib/transient-retry.ts`。
 */

export type ChatCutAssetType = 'video' | 'audio' | 'image'

export interface ChatCutUploadSource {
  filename: string
  contentType: string
  assetType: ChatCutAssetType
  /** 字节数。finalize 会与实际上传字节数核对，不一致必须报错而不是凑数 */
  size: number
  /**
   * 打开字节流。每次调用都要返回一个**新**流：PUT 重试会重读。
   * 传 `range` 表示只要这一段（分片上传用）—— 本地文件用 `createReadStream(path,{start,end})`，
   * 远端对象用 HTTP `Range` 头，两边都能只取片段而不落盘。
   */
  open: (range?: { start: number; endInclusive: number }) => Readable | Promise<Readable>
  /** 写进 finalize 的元数据；视频至少要 duration/宽高/有无音轨 */
  meta?: {
    durationInSeconds?: number
    width?: number
    height?: number
    hasAudioTrack?: boolean
  }
  /**
   * 让 ChatCut 顺手做 ASR 转录。
   * ⚠ 会消耗额度且要等（`track_progress` target=transcription）。
   * 配音轨开这个，字幕就能从真实音频派生，比我们自己切 SRT 更贴口型。
   */
  startTranscription?: boolean
}

export interface ChatCutImportSession {
  endpoint: string
  token: string
  expiresAtMs: number
}

export interface ChatCutProjectRef {
  projectId: string
  editorUrl?: string
  timelineId?: string
  trackIds: string[]
}

export interface ChatCutExportStatus {
  renderId: string
  status: 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED'
  downloadUrl?: string
  errorMessage?: string
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}

/** 与官方助手同款：同一请求体得到同一 requestId ⇒ 重试幂等 */
function requestIdFor(body: unknown): string {
  return `dashuai-${createHash('sha256').update(stableJson(body)).digest('hex')}`
}


function pickString(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/** 在上传会话响应里找 endpoint/token —— 官方没公布 schema，只做「顶层 + 一层嵌套」的容错 */
function extractSession(value: Record<string, unknown>, raw: unknown): ChatCutImportSession {
  const candidates: Record<string, unknown>[] = [value]
  for (const key of ['session', 'uploadSession', 'data', 'importSession']) {
    const nested = value[key]
    if (nested && typeof nested === 'object') candidates.push(nested as Record<string, unknown>)
  }
  for (const candidate of candidates) {
    const endpoint = pickString(candidate, 'endpoint', 'uploadEndpoint', 'url')
    const token = pickString(candidate, 'token', 'sessionToken', 'uploadToken')
    if (endpoint && token) {
      const ttl = Number(candidate.ttlSeconds ?? 1800)
      const expiresAt = pickString(candidate, 'expiresAt')
      const parsedExpiry = expiresAt ? Date.parse(expiresAt) : Number.NaN
      return {
        endpoint,
        token,
        expiresAtMs: Number.isFinite(parsedExpiry)
          ? parsedExpiry
          : Date.now() + (Number.isFinite(ttl) ? ttl : 1800) * 1000,
      }
    }
  }
  throw new Error(`ChatCut import_media 未返回可用的上传会话：${JSON.stringify(raw).slice(0, 500)}`)
}

/**
 * 上传会话的一次 POST（不重试）。★ 重试版是下面那个 `postImport`，调用方只用它。
 * 之所以拆成两个函数而不是在调用点包一层：这里有 5 个调用点，
 * 漏包一个就会留下「大部分步骤会重试、唯独某一步不会」的暗坑 —— 而那一步恰恰可能是最常失败的。
 */
async function postImportOnce(
  session: ChatCutImportSession,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = { request, requestId: requestIdFor(request) }
  const response = await fetch(session.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(IMPORT_ATTEMPT_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`ChatCut 上传会话返回 HTTP ${response.status}：${text.slice(0, 500)}`)
  }
  if (!text.trim()) return {}
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error(`ChatCut 上传会话返回无法解析的响应：${text.slice(0, 500)}`)
  }
}

/**
 * 上传会话 POST（带瞬断重试）。
 * ★ 幂等由 `requestIdFor` 保证：重试发的是**逐字节相同**的请求体 ⇒ 同一 requestId ⇒ 服务端去重。
 *   （所以这里重试是安全的，不是在赌「大不了重复建一次」——那会真的建出两个 asset 占位。）
 */
async function postImport(
  session: ChatCutImportSession,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = String((request as { action?: unknown }).action ?? requestIdFor(request).slice(0, 16))
  return withTransientRetry(`上传会话 ${action}`, () => postImportOnce(session, request))
}

function assetUploadSlot(value: Record<string, unknown>): Record<string, unknown> {
  const slot = value.assetUpload ?? value.upload ?? value
  if (!slot || typeof slot !== 'object') {
    throw new Error(`ChatCut 未返回上传槽位：${JSON.stringify(value).slice(0, 500)}`)
  }
  return slot as Record<string, unknown>
}

/**
 * 单一 PUT。★ 必须显式发 Content-Length：预签名 URL 由 S3/COS 签发，
 * 缺长度会走 chunked，签名校验直接失败（官方助手同样带这个头）。
 */
async function putStream(
  url: string,
  open: ChatCutUploadSource['open'],
  size: number,
  contentType: string,
): Promise<string | undefined> {
  // ★ `open()` 必须在**每次尝试内部**调用：重试要拿一条新流
  //   （`ChatCutUploadSource.open` 的接口注释就是这么要求的：「PUT 重试会重读」）。
  //   写成 `body: Readable.toWeb(await open())` 然后整体重试会复用**已消费**的流 ⇒ 第二次必失败。
  return withTransientRetry(`素材上传 PUT（${size} 字节）`, async () => {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-length': String(size), 'content-type': contentType },
      body: Readable.toWeb(await open()),
      // Node 的 fetch 需要 duplex:'half' 才允许流式请求体
      duplex: 'half',
      // 整个 init 一起断言：本项目的 tsconfig 没引 DOM lib，
      // 单独引用 BodyInit 会 TS2304（`duplex` 本来也不在 RequestInit 里）
    } as unknown as RequestInit)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`ChatCut 素材上传失败（HTTP ${response.status}）：${text.slice(0, 300)}`)
    }
    return response.headers.get('etag')?.replace(/^"|"$/g, '') || undefined
  })
}

async function putRange(
  url: string,
  open: ChatCutUploadSource['open'],
  start: number,
  endInclusive: number,
): Promise<string> {
  const length = endInclusive - start + 1
  // ★ 同上：每次尝试都要重新 open 这一段
  return withTransientRetry(`分片上传 PUT（第 ${start}~${endInclusive} 字节）`, async () => {
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-length': String(length) },
      body: Readable.toWeb(await open({ start, endInclusive })),
      duplex: 'half',
    } as unknown as RequestInit)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`ChatCut 分片上传失败（HTTP ${response.status}）：${text.slice(0, 300)}`)
    }
    const etag = response.headers.get('etag')?.replace(/^"|"$/g, '')
    if (!etag) throw new Error('ChatCut 分片上传未返回 ETag，无法完成分片合并')
    return etag
  })
}

/** 大文件走分片：申请签名 → 逐片 PUT → 收集 ETag，交给 finalize 的 multipart 字段合并 */
async function putMultipart(
  session: ChatCutImportSession,
  slot: Record<string, unknown>,
  source: ChatCutUploadSource,
  uploadId: string,
  partSize: number,
  partCount: number,
): Promise<Record<string, unknown>> {
  const parts: Array<{ ETag: string; PartNumber: number }> = []
  for (let first = 1; first <= partCount; first += MULTIPART_SIGN_BATCH_SIZE) {
    const last = Math.min(partCount, first + MULTIPART_SIGN_BATCH_SIZE - 1)
    const signed = await postImport(session, {
      signPartsRequest: {
        action: 'sign_parts',
        fileKey: slot.fileKey,
        firstPartNumber: first,
        lastPartNumber: last,
        uploadId,
      },
    })
    const urls = (signed.partUrls ?? {}) as Record<string, string>
    for (let part = first; part <= last; part += 1) {
      const url = urls[String(part)]
      if (!url) throw new Error(`ChatCut 未返回第 ${part} 片的签名地址`)
      const start = (part - 1) * partSize
      const end = Math.min(source.size - 1, start + partSize - 1)
      parts.push({ ETag: await putRange(url, source.open, start, end), PartNumber: part })
    }
  }
  return { uploadId, parts }
}

/**
 * 导入一个素材，返回 ChatCut 的 assetId（时间线要用它）。
 * 四步：占位登记 → 申请槽位 → PUT 字节 → finalize。
 */
export async function importAsset(
  session: ChatCutImportSession,
  source: ChatCutUploadSource,
): Promise<string> {
  if (!Number.isInteger(source.size) || source.size <= 0) {
    throw new Error(`ChatCut 素材 ${source.filename} 大小非法：${source.size}`)
  }
  // ★ assetId 由**我们**生成（官方助手也是 randomUUID()），服务端会回显核对
  const assetId = randomUUID()
  const base = {
    assetType: source.assetType,
    contentType: source.contentType,
    filename: source.filename,
    size: source.size,
  }
  const metaFields: Record<string, unknown> = {}
  if (source.meta?.durationInSeconds !== undefined) metaFields.durationInSeconds = source.meta.durationInSeconds
  if (source.meta?.width !== undefined) metaFields.width = source.meta.width
  if (source.meta?.height !== undefined) metaFields.height = source.meta.height
  if (source.meta?.hasAudioTrack !== undefined) metaFields.hasAudioTrack = source.meta.hasAudioTrack

  await postImport(session, {
    registerAssetPlaceholderRequest: {
      action: 'register_asset_placeholder',
      assetId,
      ...base,
      ...metaFields,
    },
  })

  const prepared = await postImport(session, {
    prepareRegisteredUploadRequest: { action: 'prepare_registered_upload', assetId, ...base },
  })
  const slot = assetUploadSlot(prepared)
  const presignedUrl = pickString(slot, 'presignedUrl', 'url')
  const fileKey = pickString(slot, 'fileKey')
  const readUrl = pickString(slot, 'readUrl')
  if (!presignedUrl || !fileKey || !readUrl) {
    throw new Error(`ChatCut 上传槽位字段不全：${JSON.stringify(prepared).slice(0, 500)}`)
  }

  const multipartUploadId = pickString(slot, 'multipartUploadId')
  const partSize = Number(slot.multipartPartSizeBytes ?? 0)
  const partCount = Number(slot.multipartPartCount ?? 0)
  const multipart = multipartUploadId && partSize > 0 && partCount > 1
    ? await putMultipart(session, slot, source, multipartUploadId, partSize, partCount)
    : (await putStream(presignedUrl, source.open, source.size, source.contentType), undefined)

  await postImport(session, {
    finalizeAssetUploadRequest: {
      action: 'finalize_asset_upload',
      assetId,
      ...base,
      fileKey,
      readUrl,
      startTranscription: Boolean(source.startTranscription),
      ...metaFields,
      ...(multipart ? { multipart } : {}),
    },
  })
  return assetId
}

/**
 * 一个上传会话最多导 4 个素材，所以按批开会话。
 * ⚠ 会话有 30 分钟 TTL：大素材多的时候要留意别把会话用过期。
 */
/**
 * Node 的 fetch 失败只给一句 `TypeError: fetch failed`，真因藏在 `cause` 里
 * （ENOENT = 请求体的来源流打不开 / ECONNRESET / 证书过期…）。
 * ★ 不把 cause 带出来，线上就只能看到一个完全无法定位的「导入失败」——
 *   本轮排「TTS 临时文件被提前删掉」这个 bug 时，第一手线索就是这么一句空话。
 */
function describeImportError(error: unknown): string {
  const base = (error as Error)?.message ?? String(error)
  const cause = (error as { cause?: unknown })?.cause
  const detail =
    cause instanceof Error ? `${cause.name}: ${cause.message}` : cause == null ? '' : String(cause)
  return detail && !base.includes(detail) ? `${base}（${detail}）` : base
}

export async function importAssets(
  projectId: string,
  sources: ChatCutUploadSource[],
): Promise<Array<{ assetId: string; filename: string }>> {
  const results: Array<{ assetId: string; filename: string }> = []
  for (let start = 0; start < sources.length; start += SESSION_BATCH_SIZE) {
    const batch = sources.slice(start, start + SESSION_BATCH_SIZE)
    const session = await createImportSession(projectId)
    for (const source of batch) {
      try {
        results.push({ assetId: await importAsset(session, source), filename: source.filename })
      } catch (error) {
        // 带上文件名 + 真因：批量导入时「哪个素材、哪一步」比一句 fetch failed 有用得多
        throw new Error(`素材 ${source.filename} 导入失败：${describeImportError(error)}`)
      }
    }
  }
  return results
}

export async function createImportSession(projectId?: string): Promise<ChatCutImportSession> {
  const args: Record<string, unknown> = { action: 'create_session' }
  if (projectId) args.projectId = projectId
  const value = await callTool('import_media', args)
  return extractSession(value, value)
}

export async function createChatCutProject(input: {
  name: string
  width: number
  height: number
  fps: number
  description?: string
}): Promise<ChatCutProjectRef> {
  // ⚠ create_project 的默认画布是 1920×1080：竖屏必须显式传，否则成片横过来
  const value = await callTool('create_project', {
    name: input.name,
    compositionWidth: input.width,
    compositionHeight: input.height,
    fps: input.fps,
    ...(input.description ? { description: input.description } : {}),
  })
  const projectId = pickString(value, 'projectId', 'project_id', 'id')
  if (!projectId) throw new Error(`ChatCut create_project 未返回 projectId：${JSON.stringify(value).slice(0, 500)}`)
  const tracks = Array.isArray(value.tracks) ? (value.tracks as Array<Record<string, unknown>>) : []
  return {
    projectId,
    editorUrl: pickString(value, 'editorUrl', 'editor_url'),
    timelineId: pickString(value, 'timelineId', 'timeline_id'),
    // create_project 已经连默认视频轨一起建好，不必再调 target_project / manage_timelines
    trackIds: tracks.map((track) => pickString(track, 'id', 'trackId') ?? '').filter(Boolean),
  }
}

export async function addChatCutItems(
  projectId: string,
  adds: Array<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  return callTool('edit_item', { projectId, adds })
}

export async function updateChatCutItem(
  projectId: string,
  updates: Array<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  return callTool('edit_item', { projectId, updates })
}

/** role=anchor 是「人声轨」，role=follower 是「跟着让位的 BGM 轨」—— 两者成对设置才有自动闪避 */
export async function setChatCutTrackRole(
  projectId: string,
  trackId: string,
  role: 'anchor' | 'follower' | null,
): Promise<Record<string, unknown>> {
  return callTool('edit_track', { projectId, action: 'update', trackId, json: JSON.stringify({ role }) })
}

export async function listChatCutTracks(projectId: string): Promise<Record<string, unknown>> {
  return callTool('edit_track', { projectId, action: 'list' })
}

/**
 * 开启字幕。字幕从**转录**派生（不是烧 SRT），所以要等目标轨的 audio 转录就绪。
 *
 * ★ `preset` 就是「字幕样式」档位的落地处：它是 ChatCut 的**内置字幕预设 id**
 *   （目录见 `chatcut.ts` 的 `CAPTION_PRESETS`）。省略或传 `"auto"` 即默认 Plain 样式。
 * ⚠ `trackId` 只对 `action='track'` 有效，**绝不能传给 enable**（文档明确禁止）——
 *   想指定字幕「读哪条轨」要用 `action='set_sources'`。这里因此不接受 trackId。
 */
export async function enableChatCutCaptions(
  projectId: string,
  options: { preset?: string } = {},
): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = { projectId, action: 'enable' }
  if (options.preset) args.preset = options.preset
  return callTool('edit_captions', args)
}

/**
 * 把字幕**限定到指定轨道**（`action='set_sources'`）。
 *
 * ★★ 为什么必须做这一步（2026-09-21 实测）：`enable` 的默认行为是
 *   「Plain 样式 + **所有可听见的轨道**」——在 6 分镜项目上实测返回
 *   `sourceScope.sources = [V1(video), A1(audio)]`。也就是说默认会把
 *   **画面素材自带的声音**也当成字幕来源：AI 分镜里只要带上一点环境人声/歌词，
 *   字幕就会冒出与旁白无关的文字（而观众看到的字幕和听到的旁白对不上，
 *   比没有字幕更容易被当成事故）。有配音时字幕只该读旁白轨。
 *
 * ⚠ 文档明确：这条**不能**用 `action='track'` 代替（那个只改 captions item 的
 *   存储/遗留单轨字段，不影响「字幕读什么」），也**不能**把 trackId 传给 `enable`。
 */
export async function setChatCutCaptionSources(
  projectId: string,
  trackIds: string[],
): Promise<Record<string, unknown>> {
  return callTool('edit_captions', {
    projectId,
    action: 'set_sources',
    json: JSON.stringify({ sources: trackIds.map((trackId) => ({ trackId })) }),
  })
}

/**
 * 强制重建字幕程序（`action='refresh'`）—— 导出前把 Cue 时刻与当前时间线对齐。
 *
 * ★ 什么时候会「不对齐」：字幕是从**转录**派生的，而同一段 PREPARE 里我们还会改时间线
 *   （`clean_script` 压缩停顿、转场重排），`enable` 的返回里会明确带上
 *   `captionReconciliation: { status: 'refresh-required' }` 与
 *   「this edit may have made automatic captions stale」。
 *   不 refresh 也不报错，只是**导出用的还是旧时刻的字幕**（错位），所以这里补一次。
 * ★ 文档保证它是幂等的：编辑器若已经自行对账过，refresh 会**直接返回不写入**。
 */
export async function refreshChatCutCaptions(projectId: string): Promise<Record<string, unknown>> {
  return callTool('edit_captions', { projectId, action: 'refresh' })
}

/** 一次立即的状态读取（不是「阻塞等待到出片」）—— 非终态要隔 ≥10s 再查 */
export async function trackChatCutProgress(
  projectId: string,
  target: 'upload' | 'transcription',
  assetIds?: string[],
): Promise<Record<string, unknown>> {
  // ★★ `action` 是**必填**，漏了会被 MCP 直接拒：
  //   `-32602 Input validation error: Invalid option: expected one of "params"|"status"|"wait" (path: action)`
  //   先前没传 ⇒ **每次轮询都抛错** ⇒ 被 `pollChatCutTasks` 的 catch 当成「网络抖动」无限重试
  //   ⇒ 任务永远停在 PREPARE 的 30%（实测 990028 卡了 6 分钟、零进展）。
  //   三档语义：`status` = 读一次当前状态（外层本来就在每轮 tick 轮询，不需要服务端阻塞）；
  //   `wait` 同样是即时读；`params` 是契约自述。这里用 `status`。
  const args: Record<string, unknown> = { action: 'status', projectId, target }
  if (assetIds?.length) args.assetIds = assetIds.join(',')
  return callTool('track_progress', args)
}

/**
 * ★ 实测（2026-09-17）：ChatCut 的工具**不一定返回结构化 JSON**。
 * `submit_export` 成功时回的是给 LLM 看的人话：
 *   "Submitted export.\n  renderId: 69e3baf5fa\n  status: rendering; call track_export ..."
 * `extractStructured()` 在这种情况下只能把它塞进 `{message}` —— 于是「导出明明提交成功」
 * 却报「未返回 renderId」。所以凡是从工具结果取字段，都要**先结构化、再正则兜底**。
 */
function resultText(value: Record<string, unknown>): string {
  const text = value.message ?? value.text ?? value.content
  return typeof text === 'string' ? text : ''
}

/**
 * 从人话里捞生成任务 id（`submit_music` 的返回**只有一个 message 字符串**）。
 *
 * ★★ 实测原文（2026-09-21，真提交一个 instrumental 任务拿到）：
 *   `{"message":"Submitted instrumental music generation job.\n  jobId: 75d11fa728\n
 *     name: dashuai-bgm\n\nUse track_progress with jobId=\"75d11fa728\" to wait for the audio asset."}`
 *   ⇒ 没有 `jobId` 字段可读，id 只存在于这段文本里（且是**短前缀**，track_progress 明确接受前缀）。
 *   旧写法只 pickString 结构化字段 ⇒ 永远拿不到 jobId ⇒ 记一句「无法自动排轨」就收工，
 *   于是「选了配乐」看起来生效、实际**一次都没排上去**。这类静默要靠实测才看得见。
 */
function jobIdFromText(text: string): string | undefined {
  return text.match(/\bjob_?id\b["\s:=]+"?([0-9a-z-]{6,})"?/i)?.[1]
}

/** 从人话里捞 `renderId: xxx` / `renderIds=x,y` 这类键值，命中全部 */
function extractRenderIds(value: Record<string, unknown>): string[] {
  const structured = value.renderIds ?? value.renderId
  const list = Array.isArray(structured)
    ? structured.map(String)
    : typeof structured === 'string'
      ? structured.split(',').map((item) => item.trim()).filter(Boolean)
      : []
  if (list.length > 0) return list
  const renders = value.renders ?? value.exports
  if (Array.isArray(renders)) {
    const fromList = renders
      .map((item) => (item && typeof item === 'object' ? pickString(item as Record<string, unknown>, 'renderId', 'id') : undefined))
      .filter((id): id is string => Boolean(id))
    if (fromList.length > 0) return fromList
  }
  const ids = new Set<string>()
  for (const match of resultText(value).matchAll(/\brenderIds?\s*[:=]\s*"?([0-9a-zA-Z_-]{6,})"?/g)) {
    match[1]!.split(',').forEach((item) => ids.add(item.trim()))
  }
  return [...ids].filter(Boolean)
}

export async function submitChatCutExport(
  projectId: string,
  options: {
    format?: 'video' | 'audio' | 'subtitles' | 'xml' | 'archive'
    codec?: 'h264' | 'vp8' | 'mp3'
    resolution?: '480p' | '720p' | '1080p'
    fps?: number
    name?: string
    timelineId?: string
  } = {},
): Promise<string[]> {
  const value = await callTool('submit_export', {
    projectId,
    format: options.format ?? 'video',
    codec: options.codec ?? 'h264',
    resolution: options.resolution ?? '1080p',
    ...(options.fps ? { fps: options.fps } : {}),
    ...(options.name ? { name: options.name } : {}),
    ...(options.timelineId ? { timelineId: options.timelineId } : {}),
  })
  const list = extractRenderIds(value)
  if (list.length === 0) {
    throw new Error(`ChatCut submit_export 未返回 renderId：${JSON.stringify(value).slice(0, 500)}`)
  }
  return list
}

function mapExportState(raw: string): ChatCutExportStatus['status'] {
  const value = raw.toUpperCase()
  if (['SUCCESS', 'SUCCEEDED', 'COMPLETED', 'COMPLETE', 'DONE', 'FINISHED', 'READY'].includes(value)) return 'SUCCESS'
  if (['FAILED', 'ERROR', 'CANCELLED', 'CANCELED'].includes(value)) return 'FAILED'
  if (['RUNNING', 'PROCESSING', 'RENDERING', 'IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING'].includes(value)) return 'RUNNING'
  return 'QUEUED'
}

/**
 * `track_export` / `track_progress` 的真实返回形状（实测）：
 *   { entries: [{ renderId|id, status:"complete", ok:true, terminal:true, downloadUrl, ... }],
 *     success: true, terminal: true }
 * 所以同一套 `entries` 解析对两者都适用 —— 之前按 `renders`/`exports` 找，一个都命中不了。
 */
function resultEntries(value: Record<string, unknown>): Record<string, unknown>[] {
  for (const key of ['entries', 'renders', 'renderIds', 'exports', 'items']) {
    const list = value[key]
    if (Array.isArray(list)) return list.filter((item) => item && typeof item === 'object') as Record<string, unknown>[]
  }
  return []
}

function findRender(value: Record<string, unknown>, renderId: string): Record<string, unknown> {
  const entries = resultEntries(value)
  const match = entries.find((item) => (pickString(item, 'renderId', 'id') ?? '').startsWith(renderId))
  if (match) return match
  if (entries.length === 1) return entries[0]!
  return value
}

export async function trackChatCutExport(
  projectId: string,
  renderId: string,
): Promise<ChatCutExportStatus> {
  // action=wait 也只是一次即时读取：非终态不要在这里死等，交给外层轮询
  const value = await callTool('track_export', {
    projectId,
    action: 'wait',
    renderIds: renderId,
  })
  const render = findRender(value, renderId)
  const text = resultText(render) || resultText(value)

  const pickup = (...keys: string[]): string | undefined => {
    const fromStructured = pickString(render, ...keys) ?? pickString(value, ...keys)
    if (fromStructured) return fromStructured
    // 人话形态：`status: done` / `downloadUrl: https://...`
    for (const key of keys) {
      const match = text.match(new RegExp(`${key}\\s*[:=]\\s*"?([^"\\s,]+)"?`, 'i'))
      if (match?.[1]) return match[1]
    }
    return undefined
  }

  // ⚠ 人话里的状态词不止 SUCCESS：done / complete / ready / failed 都会出现，
  //   而「renderId 还在跑」与「已经能下载」是两条必须分开的路 —— 认错会白等或白失败
  const statusText = pickup('status', 'state') ?? 'QUEUED'
  const mapped = mapExportState(statusText)
  // 兜底：报的状态词不在白名单里（例如 "rendering" 之外的自造词）时，有下载地址就算成
  const downloadUrl =
    pickup('downloadUrl', 'download_url', 'url') ??
    text.match(/https?:\/\/[^\s"')]+/)?.[0]
  const status: ChatCutExportStatus['status'] =
    mapped === 'QUEUED' && downloadUrl ? 'SUCCESS' : mapped

  return {
    renderId,
    status,
    downloadUrl,
    errorMessage:
      pickup('errorMessage', 'error') ??
      (status === 'FAILED' ? text.slice(0, 300) || undefined : undefined),
  }
}

/** 清理：软删除（数据保留，可用 restore_project 还原） */
export async function deleteChatCutProject(projectId: string): Promise<void> {
  await callTool('delete_project', { projectId })
}

// ──────────────────────────── 生产管线：整片 AI 档 ────────────────────────────
//
// 与冒烟脚本的区别只有三点：素材来自 COS（用签名 URL 取字节）、配音来自本地火山 TTS、
// 以及**必须分阶段**（字幕依赖 ASR 转录，转录要几分钟，不能在 worker 的一次 tick 里干等）。
//
// 阶段：PREPARE（等上传就绪 + 等转录 → 开字幕）→ RENDER（导出 → 轮询成片）
// 状态存进 `renderTask.paramsJson.chatcutJob`，由 worker 每轮带进来。

export interface ChatCutJobState {
  projectId: string
  timelineId?: string
  editorUrl?: string
  /** 导出是「需要云端字节」的操作 ⇒ 提交导出前必须确认这些素材都 ready */
  uploadAssetIds: string[]
  /** 需要等转录的素材（只有配音轨开转录；分镜素材开转录纯属浪费额度） */
  transcriptionAssetIds: string[]
  phase: 'PREPARE' | 'RENDER'
  renderId?: string
  /**
   * PREPARE 阶段何时开始等（毫秒时间戳）。转录等待有**预算上限**：
   * 超预算就放弃字幕直接出片 —— 否则「转录一直不就绪」会一路拖到 30 分钟被 sweeper 退款，
   * 用户拿到的是一分钱没花但也没有片子。有字幕固然好，没字幕也该出片。
   */
  prepareStartedAtMs?: number
  /** 已记录的原因（字幕被放弃等），用于排查「为什么没有字幕」 */
  notices?: string[]
  /**
   * BGM 生成任务 id（`submit_music` 在 startChatCutRender 里提交，返回的 jobId）。
   * ★ 排轨要等生成就绪（分钟级），所以只能跨轮询 tick 做 —— 存放该 id 让每轮能查一次。
   */
  bgmJobId?: string
  /** BGM 生成提交时刻（毫秒时间戳）。与转录一样有**预算**：超了就放弃 BGM 直接出片。 */
  bgmStartedAtMs?: number
  /** 已成功排到时间线上（幂等标记：每轮只排一次） */
  bgmPlaced?: boolean
  /** BGM 排轨用的音频轨 id（已建过就不要重复建） */
  bgmTrackId?: string
  /**
   * 字幕与「清理停顿」是否已处理过。
   *
   * ★ 为什么需要这个标记：PREPARE 阶段可能因为**另一个软等待**（BGM 生成）而多轮进入同一段代码，
   *   而 `edit_captions enable` 与 `clean_script` 都是**会写时间线**的动作 ——
   *   每轮重放一遍，轻则白跑一次转录计算，重则把已经压好的停顿再压一次。
   *   （以前没有 BGM 这条等待链时，这一段的「只会走到一次」是靠流程顺序隐式保证的。）
   */
  captionsDone?: boolean
  /**
   * 字幕样式档位。★ 要在 PREPARE 阶段（转录就绪时）才用它开字幕，而那时距
   * `startChatCutRender` 已经隔了好几轮 tick ⇒ 必须随任务状态存下来，不能只当局部变量。
   */
  subtitleStyle?: ChatCutOptions['subtitleStyle']
  /** 是否清理停顿（同样只能在转录就绪后执行，所以也要跨 tick 存） */
  removeSilence?: boolean
  /**
   * 阶段内的细粒度进度（0~1），供 worker 换算成用户可见的百分比。
   *
   * ★ 为什么需要：PREPARE 要等「上传就绪」再等「转录就绪」，**分钟级**；而进度在这整段时间里
   *   只显示阶段起点（30%），用户看到的就是「又卡住了」。远端 `track_progress` 每条 entry 自带
   *   `progress`（0~1），取均值就能让进度真的在动。拿不到就不给（worker 退回显示阶段起点值）。
   */
  stageRatio?: number
  /**
   * 连续轮询失败次数。
   *
   * ★ 为什么需要：轮询失败的 catch 会「保持 RUNNING，下一轮重试」—— 这条策略本身对（网络抖动
   *   不该杀任务），但它有个致命副作用：**只要存在一个必然失败的理由，任务就会安静地无限重试**。
   *   实测就踩到了：`track_progress` 漏传必填的 `action`，每次调用都被 MCP 拒（-32602），
   *   而那条错误只出现在被吞掉的 catch 里 ⇒ 任务在 PREPARE/30% 卡了 6 分钟、库里零线索。
   *   所以失败要计数，超过上限**明确失败并带上真实原因**，而不是永远安静地转圈。
   */
  pollErrors?: number
}

export interface ChatCutRenderResult {
  status: 'RUNNING' | 'SUCCESS' | 'FAILED'
  state: ChatCutJobState
  resultUrl?: string
  errorMessage?: string
}

const TRANSCRIPTION_WAIT_MS = Number(process.env.CHATCUT_TRANSCRIPTION_WAIT_MS ?? 300_000)

/**
 * 音色映射。`CHATCUT_VOICES` 的 5 个 id 是我们对外的抽象档位，
 * 落到火山 TTS 需要真实的 speaker id。**不硬编码**（各账号可用音色不同），
 * 用环境变量给运营配：`CHATCUT_TTS_VOICE_WARM_FEMALE=zh_female_xxx`。
 * 没配就沿用后台 TTS 供应商自己的 voiceId —— 表现为「换档位不改音色」，
 * 这比猜一个不存在的 speaker id 直接合成失败要好。
 */
export const VOICE_ENV_KEYS: Record<string, string> = {
  'warm-female': 'CHATCUT_TTS_VOICE_WARM_FEMALE',
  'bright-female': 'CHATCUT_TTS_VOICE_BRIGHT_FEMALE',
  'gentle-male': 'CHATCUT_TTS_VOICE_GENTLE_MALE',
  'magnetic-male': 'CHATCUT_TTS_VOICE_MAGNETIC_MALE',
  'energetic-youth': 'CHATCUT_TTS_VOICE_ENERGETIC_YOUTH',
}

/**
 * 从探测响应里取**对象总字节数**。
 * Range 命中：`Content-Range: bytes 0-0/619077` ⇒ 取分母（这才是完整长度）。
 * 对方忽略 Range 而回了完整响应时，退回落 `Content-Length`。
 */
function readTotalSize(res: Response): number {
  const total = Number((res.headers.get('content-range') ?? '').split('/').pop())
  if (Number.isFinite(total) && total > 0) return total
  return Number(res.headers.get('content-length') ?? 0)
}

/**
 * 从 COS 签名 URL 拉素材：先探一次字节数（finalize 会核对），再给流。
 *
 * ★★ 探测**绝不能用 HEAD** —— COS 的 q-signature **把 HTTP 方法算进签名**，
 *    而 SDK 签出来的临时 URL 是按 **GET** 签的。拿 HEAD 去请求同一个 URL，
 *    COS 判签名不匹配、直接回 **403**（不是 404、也不是 405，看着像「没权限」，
 *    极难往「方法不对」上想）。2026-09-18 实测同一个 URL：
 *      `HEAD → 403`、`GET → 200`、`GET + Range: bytes=0-0 → 206`。
 *    后果是 AI 档**每次合成都卡在第一步**，抛「取素材大小失败（HTTP 403）：shot-3.mp4」，
 *    100% 失败 —— 而且因为异常发生在推素材之前，看起来像素材本身有问题。
 *
 *    改用「带 Range 的 GET」：服务端只回 1 个字节，代价与 HEAD 相当，
 *    总长度从 `Content-Range` 的分母里取（见 readTotalSize）。
 */
async function remoteSource(
  url: string,
  filename: string,
  contentType: string,
  durationMs: number | null,
): Promise<ChatCutUploadSource> {
  const probe = await fetch(url, { headers: { range: 'bytes=0-0' }, signal: AbortSignal.timeout(30_000) })
  if (!probe.ok) throw new Error(`取素材大小失败（HTTP ${probe.status}）：${filename}`)
  // 探针会带回 1 个字节的 body：不读掉就会一直占着这条连接（keep-alive 下尤其明显）
  await probe.arrayBuffer().catch(() => undefined)
  const size = readTotalSize(probe)
  if (!Number.isFinite(size) || size <= 0) throw new Error(`素材 ${filename} 的字节数非法：${size}`)

  // ★★ 必须声明**完整且正确**的元数据。缺 width/height 时 ChatCut 的 import registration
  //    直接回 400 —— 实测 990025：`helper import registration for video requires complete
  //    metadata so the backend does not process large files locally`。
  //    而 `media_asset.width/height` 由客户端在上传确认时**选择性**上报（视频仅 25/56 有值），
  //    所以只能现探；探不到就**明确报错**，绝不拿画布尺寸凑数（错的比例比缺失更糟）。
  const meta = await probeClipMeta(url)
  if (!meta.ok || !meta.width || !meta.height) {
    throw new Error(`素材 ${filename} 的元数据不全，无法提交云端合成：${meta.reason ?? '缺少视频宽高'}`)
  }
  return {
    filename,
    contentType,
    assetType: 'video',
    size,
    open: async (range) => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(600_000),
        ...(range ? { headers: { range: `bytes=${range.start}-${range.endInclusive}` } } : {}),
      })
      if (!response.ok || !response.body) throw new Error(`下载素材失败（HTTP ${response.status}）：${filename}`)
      return Readable.fromWeb(response.body as never)
    },
    meta: {
      width: meta.width,
      height: meta.height,
      // 时长以**探到的真实值**为准（客户端上报的 durationMs 可能缺/偏）；两个都没有就不声明
      ...(meta.durationMs || durationMs
        ? { durationInSeconds: (meta.durationMs ?? durationMs!) / 1000 }
        : {}),
      hasAudioTrack: meta.hasAudioTrack,
    },
  }
}

// ★ framesOf 已搬到 chatcut-timing.ts —— 与 planShotTiming 同源，避免「两份实现漂移」。
//   import 见文件顶部。那边还带一条硬约束：**必须向下取整**（否则会被 ChatCut 拒单）。

/**
 * 把探测到的宽高回填 `media_asset`（**只在原本为空时写**）。
 *
 * 客户端是选择性上报宽高的，实测视频仅 25/56 有值 —— 不回填的话，同一批素材会被
 * 每个 AI 任务重新探一遍。这是纯缓存性质的优化：任何失败都吞掉（调用点已 catch），
 * 绝不能因为它让一条本来能出的片子失败。
 */
async function backfillClipMeta(assetId: string, meta: ChatCutUploadSource['meta']): Promise<void> {
  if (!/^\d+$/.test(assetId)) return
  if (!meta?.width || meta.width <= 0 || !meta.height || meta.height <= 0) return
  await prisma.mediaAsset.updateMany({
    where: { id: BigInt(assetId), width: null },
    data: { width: meta.width, height: meta.height },
  })
}

/**
 * 阶段上报的安全包装。`onPhase` 是 worker 注入的可观测性钩子，
 * 它写库/打日志失败**绝不能把一条本来能出的片子搞失败**。
 */
function safePhase(input: ChatCutJobInput, ratio: number, label: string): void {
  try {
    input.onPhase?.({ ratio, label })
  } catch (error) {
    console.warn(`[chatcut] onPhase 回调异常（已忽略）：${(error as Error).message}`)
  }
}

// ───────────────────── 「6 项打磨」的真实落地（2026-09-21） ─────────────────────
//
// 此前这 6 项是「收了但不用的装饰控件」：schema 与默认值都在，行为为零。
// 本段把它们接到真实原语上。三条设计判据都是**实测**得出的，改之前先读：
//
//   ① 转场 / 音量 / 节奏必须**排在排轨之后**：转场要引用已存在的 item id
//      （`edit_item adds:[{type:'transition', outgoingItemId, incomingItemId}]`），
//      而 item id 只有排轨之后才存在。取 id 的唯一可靠来源是 `preview_timeline`
//      —— `edit_item` 自己的文档就写着「要复制刚加进去的 item，请在 preview_timeline
//      之后再发一次」⇒ **adds 的返回不保证给出新建 item 的 id**。
//   ② 响度归一 ChatCut **没有原语**：59 个工具里没有 loudness / normalize / LUFS 类操作，
//      `submit_export` 也没有音频归一选项。唯一能改音量的字段是
//      `edit_item updates[].decibelAdjustment`（`0`=不变、`-60`≈静音）。
//      ⇒ 只能「本地 ffmpeg 把每段真实响度测出来 → 算每一条该加/减多少 dB」。
//   ③ 剪辑节奏用**缩短镜头**而不是 `playbackRate`（变速）：变速会让源素材消耗量变成
//      「时长 × 倍率」，加速要多耗源字节，分镜已把素材用满时就会撞
//      `Source range exceeds video asset duration` 拒单（2026-09-17 踩过）。
//      缩短镜头只会**减少**消耗，怎么改都不会越界。
//
// ★★ 铁律：这 6 项一律「失败只记 notice、绝不阻塞出片」。它们是打磨，不是出片的必要条件。
//    用户宁可拿到一部没有转场的片子，也不要一个「因为转场报错而失败」的任务。
//    所以下面每个动作都单独 try/catch，且**不做重试**（重试交给整个任务的 sweeper 语义）。

/** 配音的响度目标（LUFS）。-16 是短视频平台常见目标：人声清楚、又不至于压到爆。 */
const VOICE_TARGET_LUFS = -16

/**
 * 有配音时**画面原声**的响度目标（LUFS）。
 *
 * ★ 为什么刻意跟人声拉开 10dB：分镜素材自带的是现场/素材原声，它是**背景层**。
 *   若把它也归到 -16，「统一音量」就变成「环境噪声和人声一样响」—— 那不是修好，是事故。
 *   ⚠ 这一层本该由 `edit_track` 的 ducking 处理，但 ducking 只作用于 BGM 轨与被显式设为
 *     follower 的轨，且深度由引擎按时间线响度**自推**、我们控不了绝对值；
 *     静态增益才是我们能精确控制的那一半。
 */
const AMBIENCE_TARGET_LUFS = -26

/** 单条补偿的上下限：加太多会削波、减太多等于静音（`-60` 就是静音）。 */
const LOUDNESS_ADJUST_MIN_DB = -30
const LOUDNESS_ADJUST_MAX_DB = 12

/** 小于这个幅度就不动 —— 免得把「本来就对」的也改一遍，还平白多出浮点噪声。 */
const LOUDNESS_ADJUST_DEADBAND_DB = 1

/**
 * 配音结尾留的呼吸余量（毫秒）。
 * ★ 镜头时长刚好等于「这句话的长度」时，下一句会紧贴上一句的最后一个字，
 *   听起来像抢拍；留 200ms 的尾巴才像人说话。
 */
const VOICE_TAIL_MARGIN_MS = 200

// ★ TRANSITION_HANDLE_MAX_RATIO 已搬到 chatcut-timing.ts（只被 handleFramesOf 用）。
//   它仍是「转场给单个镜头预留素材的比例上限」= 0.15，理由见那边的注释。

/** BGM 生成的等待预算（毫秒）。理由同转录预算：宁可没 BGM 出片，也不要一路拖到 sweeper 退款。 */
const BGM_WAIT_MS = Number(process.env.CHATCUT_BGM_WAIT_MS ?? 240_000)

export function chatCutBgmEnabled(): boolean {
  return (process.env.CHATCUT_BGM_ENABLED ?? '').trim().toLowerCase() === 'true'
}

/** 时间线上一个已排布的条目（`preview_timeline` 的 entries 元素） */
export interface ChatCutTimelineEntry {
  id: string
  itemType: string
  trackAlias?: string
  trackId?: string
  fromFrame: number
  toFrame: number
  assetName?: string
}

export interface ChatCutTimelineView {
  durationFrames: number
  entries: ChatCutTimelineEntry[]
  tracks: Array<{ id: string; alias?: string; trackType?: string; role?: string }>
}

/**
 * 读时间线结构（只读）。
 *
 * ★★ 为什么必须用它、而不是从 `edit_item adds` 的返回里抠 item id：
 *   转场（`outgoingItemId` / `incomingItemId`）与逐条音量补偿（`updates[].id`）
 *   **都必须有 item id**，而 adds 的返回不保证给出新建 item 的 id（见本段开头的 ①）。
 *   这是本项目「猜远端返回形状」翻过车的地方，所以这里只认一个来源。
 *
 * 真实返回形状（2026-09-21 在项目 9150a917 上抓的原文，都在 structuredContent 里）：
 *   timeline.entries[] = { id, itemType:'video'|'audio', kind:'item',
 *                          asset:{id,name,type}, startFrame,
 *                          timelineRange:{fromFrame,toFrame}, trackAlias, trackId }
 *   timeline.tracks[]  = { id, alias, trackType, order, audioDucking:{role}, hidden, muted }
 *   state.durationFrames
 * ⚠ 人话版 text（content[0].text）**不是 JSON**（是 `- item V1 [id] type=video …` 那种），
 *   `extractStructured()` 会在 JSON.parse 失败后自动退回 structuredContent —— 这条链是通的。
 */
export async function previewChatCutTimeline(projectId: string): Promise<ChatCutTimelineView> {
  const value = await callTool('preview_timeline', { projectId, views: ['timeline'], limit: 100 })
  const timeline = (value.timeline ?? {}) as Record<string, unknown>
  const state = (value.state ?? {}) as Record<string, unknown>
  const rawEntries = Array.isArray(timeline.entries) ? (timeline.entries as Record<string, unknown>[]) : []
  const rawTracks = Array.isArray(timeline.tracks) ? (timeline.tracks as Record<string, unknown>[]) : []

  const entries: ChatCutTimelineEntry[] = []
  for (const raw of rawEntries) {
    const id = pickString(raw, 'id')
    if (!id) continue
    const range = (raw.timelineRange ?? {}) as Record<string, unknown>
    const asset = (raw.asset ?? {}) as Record<string, unknown>
    const fromFrame = Number(range.fromFrame)
    const toFrame = Number(range.toFrame)
    entries.push({
      id,
      itemType: (pickString(raw, 'itemType', 'type') ?? '').toLowerCase(),
      trackAlias: pickString(raw, 'trackAlias'),
      trackId: pickString(raw, 'trackId'),
      fromFrame: Number.isFinite(fromFrame) ? fromFrame : Number(raw.startFrame) || 0,
      toFrame: Number.isFinite(toFrame) ? toFrame : 0,
      assetName: pickString(asset, 'name'),
    })
  }

  return {
    durationFrames: Number(state.durationFrames) || 0,
    entries,
    tracks: rawTracks
      .map((raw) => {
        const ducking = (raw.audioDucking ?? {}) as Record<string, unknown>
        return {
          id: pickString(raw, 'id') ?? '',
          alias: pickString(raw, 'alias', 'trackAlias'),
          trackType: pickString(raw, 'trackType', 'type'),
          role: pickString(ducking, 'role'),
        }
      })
      .filter((track) => Boolean(track.id)),
  }
}

/** 按素材名把 item 归到分镜序列（`shot-1.mp4` → 下标 0），并按时间线顺序排序 */
export function orderShotItems(entries: ChatCutTimelineEntry[]): ChatCutTimelineEntry[] {
  const shots = entries.filter((entry) => entry.itemType === 'video')
  return shots.sort((a, b) => a.fromFrame - b.fromFrame)
}

/**
 * 在视频轨的每个接缝上加转场。接缝 = 相邻两个视频 item 的边界。
 *
 * ★★ 每个接缝的转场**时长**不是直接照抄档位值，而要按两侧**实际预留的素材余量**收窄：
 *   实测关系是「可行帧数上限 = 2 × handle − 2」（handle = 该侧预留的帧数，
 *   见 chatcut.ts `TRANSITION_PLANS` 的注释）。相邻两个镜头的余量未必一样
 *   （短镜头会被按比例压低），所以逐个接缝取 `min`，算出来不足 3 帧就干脆跳过这个接缝 ——
 *   宁可这里保留硬切，也不要发一个必然被 ChatCut 拒掉的批量（整批原子回滚 = 全片没有转场）。
 *
 * ★ 用**显式** outgoing/incoming，不用 `trackId + fromFrame` 的边界简写：
 *   简写只在「端点无歧义」时成立，而歧义与否取决于远端当下的轨道状态；
 *   显式给 item id 是我们唯一能自己保证的部分（id 直接从 `preview_timeline` 来）。
 * ★ 同一种转场在同一个接缝上重复添加是**幂等**的（文档明确说会替换/更新而不是叠加），
 *   所以这段即使被重跑一次也不会把转场堆起来。
 */
async function addChatCutTransitions(
  projectId: string,
  shots: ChatCutTimelineEntry[],
  plan: (typeof TRANSITION_PLANS)[keyof typeof TRANSITION_PLANS],
  handleFrames: number[],
  notices: string[],
): Promise<number> {
  if (!plan.assetId || plan.durationFrames <= 0) return 0

  const buildAdds = (limit: number): Array<Record<string, unknown>> => {
    const batch: Array<Record<string, unknown>> = []
    for (let index = 0; index + 1 < shots.length; index += 1) {
      const left = handleFrames[index] ?? 0
      const right = handleFrames[index + 1] ?? 0
      const feasible = 2 * Math.min(left, right) - 2
      const duration = Math.min(limit, feasible)
      if (duration < 3) continue
      batch.push({
        type: 'transition',
        assetId: plan.assetId,
        outgoingItemId: shots[index]!.id,
        incomingItemId: shots[index + 1]!.id,
        durationInFrames: duration,
      })
    }
    return batch
  }

  /**
   * ★★ 为什么要有这条「逐档下调」的阶梯（2026-09-21 干跑后补）：
   *   档位值（SMOOTH 10 帧 / DYNAMIC 14 帧）是按 `可行帧数 = 2×handle − 2` 算出来的，
   *   实测恰好**贴着上限通过**（handle 6 → 上限 10；handle 8 → 上限 14）。
   *   但那条关系里的 handle 数是我们按 ffprobe 报的素材时长反推的，而 ChatCut 校验时用的是
   *   它自己探到的素材时长 —— 两边差 1 帧（约 33ms）完全可能。一旦差 1 帧，
   *   这批 adds 会被**整批原子回滚**（= 全片一个转场都没有），而打磨段是「失败只记 notice」
   *   ⇒ 线上表现成「选了转场却没效果」，且**代码路径上看不出任何异常**。
   *   所以宁可把每个转场缩短一点，也不要一个都加不上。
   */
  const ladder = [plan.durationFrames, Math.max(3, Math.round(plan.durationFrames * 0.6))]
  let lastError: Error | null = null
  for (let attempt = 0; attempt < ladder.length; attempt += 1) {
    const limit = ladder[attempt]!
    const adds = buildAdds(limit)
    if (adds.length === 0) return 0
    try {
      // 一次调用整批提交（原子）：半个片子的转场比没有转场更难理解
      await callTool('edit_item', { projectId, adds })
      if (adds.length < shots.length - 1) {
        notices.push(`有 ${shots.length - 1 - adds.length} 处接缝的素材余量不足 ⇒ 那些位置保留硬切`)
      }
      if (limit < plan.durationFrames) {
        notices.push(`转场按 ${limit} 帧加入（档位 ${plan.durationFrames} 帧超出了素材余量）`)
      }
      return adds.length
    } catch (error) {
      lastError = error as Error
    }
  }
  notices.push(`转场添加失败（本次成片不加转场）：${(lastError?.message ?? '').slice(0, 120)}`)
  return 0
}

/**
 * 逐条音量归一：把「目标响度 − 实测响度」算成 `decibelAdjustment` 一次批量下发。
 *
 * ★ 分成两组是因为「统一音量」不等于「所有东西一样响」：人声与画面原声是两个角色，
 *   各有各的目标（见 AMBIENCE_TARGET_LUFS）。目标值之差就是刻意保留的层次。
 * ★ 测不出响度的条目（无音轨 / 探测失败 / 超时）**跳过而不是按 0 处理** ——
 *   按 0 会把「不知道」当成「已经是对的」，等于悄悄放弃。
 */
async function normalizeChatCutLoudness(
  projectId: string,
  groups: Array<{ items: Array<{ id: string; lufs: number | null }>; target: number }>,
): Promise<{ adjusted: number; skipped: number }> {
  const updates: Array<Record<string, unknown>> = []
  let skipped = 0
  for (const group of groups) {
    for (const item of group.items) {
      if (item.lufs === null || !Number.isFinite(item.lufs)) {
        skipped += 1
        continue
      }
      const raw = Math.round((group.target - item.lufs) * 10) / 10
      const delta = Math.max(LOUDNESS_ADJUST_MIN_DB, Math.min(LOUDNESS_ADJUST_MAX_DB, raw))
      if (Math.abs(delta) < LOUDNESS_ADJUST_DEADBAND_DB) {
        skipped += 1
        continue
      }
      updates.push({ id: item.id, decibelAdjustment: delta })
    }
  }
  if (updates.length === 0) return { adjusted: 0, skipped }
  await callTool('edit_item', { projectId, updates })
  return { adjusted: updates.length, skipped }
}

/** `smooth_audio`：给每个相邻音频接缝加短交叉淡化、给每个裸露的音频边缘加短淡入淡出（消爆音）。 */
async function smoothChatCutAudio(projectId: string): Promise<Record<string, unknown>> {
  return callTool('smooth_audio', { projectId })
}

// ────────────────────────── 打磨编排（第 4 步之后） ──────────────────────────

interface ChatCutPolishArgs {
  projectId: string
  /** 转场档位的落地计划（assetId 为 null = 硬切，不加转场） */
  transitionPlan: (typeof TRANSITION_PLANS)[keyof typeof TRANSITION_PLANS]
  /** 与 `input.clips` 同序：每个镜头**已经预留**的素材余量（帧）。转场时长不能超过它推出来的上限 */
  handleFrames: number[]
  normalizeAudio: boolean
  /** 与 `input.clips` 同序：每段分镜源素材的实测响度（null = 测不出） */
  clipLufs: Array<number | null>
  /** 与分镜下标对应：每段配音的实测响度（null = 无配音 / 测不出） */
  voiceLufs: Map<number, number | null>
  hasVoice: boolean
}

/**
 * 排轨之后的所有打磨：转场 → 统一音量 → 消爆音。
 * 每一步单独兜错并写进 notices —— 见本段开头的铁律。
 */
async function polishChatCutTimeline(
  args: ChatCutPolishArgs,
  notices: string[],
): Promise<void> {
  let view: ChatCutTimelineView
  try {
    view = await previewChatCutTimeline(args.projectId)
  } catch (error) {
    notices.push(`读时间线失败 ⇒ 跳过转场与音量统一：${(error as Error).message}`)
    return
  }

  const shots = orderShotItems(view.entries)

  // ── ① 转场（逐接缝）
  try {
    const count = await addChatCutTransitions(
      args.projectId,
      shots,
      args.transitionPlan,
      args.handleFrames,
      notices,
    )
    notices.push(
      count > 0
        ? `已加 ${count} 处转场（${args.transitionPlan.assetId}，${args.transitionPlan.durationFrames} 帧/处）`
        : args.transitionPlan.assetId
          ? '接缝可用的素材余量不足 ⇒ 本片按硬切处理'
          : '转场风格选了硬切 ⇒ 不加转场',
    )
  } catch (error) {
    notices.push(`转场添加失败（本片无转场）：${(error as Error).message}`)
  }

  // ── ② 统一音量
  if (args.normalizeAudio) {
    try {
      // ★ 分镜 item 按时间线顺序 = clips 顺序（排轨时就是这样加的），所以下标可以对上。
      //   不按 assetName 反查是为了不留「远端改了命名就静默错位」的隐患。
      const shotItems = shots.map((item, index) => ({ id: item.id, lufs: args.clipLufs[index] ?? null }))
      const voiceItems = view.entries
        .filter((entry) => entry.itemType === 'audio')
        .sort((a, b) => a.fromFrame - b.fromFrame)
        .map((item, index) => ({ id: item.id, lufs: args.voiceLufs.get(index) ?? null }))

      const groups: Array<{ items: Array<{ id: string; lufs: number | null }>; target: number }> = [
        { items: voiceItems, target: VOICE_TARGET_LUFS },
        // 无配音 ⇒ 画面原声就是主声源，按人声目标；有配音 ⇒ 它是背景层，压低 10dB
        { items: shotItems, target: args.hasVoice ? AMBIENCE_TARGET_LUFS : VOICE_TARGET_LUFS },
      ]
      const { adjusted, skipped } = await normalizeChatCutLoudness(args.projectId, groups)
      notices.push(`音量统一：已调整 ${adjusted} 条，跳过 ${skipped} 条（测不出响度或已在容差内）`)
    } catch (error) {
      notices.push(`音量统一失败（保持原音量）：${(error as Error).message}`)
    }
  }

  // ── ③ 消接缝爆音（放在音量统一之后：增益变了，接缝爆点也会跟着变）
  try {
    const result = await smoothChatCutAudio(args.projectId)
    const crossfades = Number((result as { crossfades?: unknown }).crossfades)
    notices.push(
      Number.isFinite(crossfades)
        ? `音频平滑完成（交叉淡化 ${crossfades} 处）`
        : '音频平滑完成',
    )
  } catch (error) {
    notices.push(`音频平滑失败（可能有轻微接缝爆音）：${(error as Error).message}`)
  }
}

export async function startChatCutRender(input: ChatCutJobInput): Promise<ChatCutRenderResult> {
  const clips = input.clips.filter((clip) => clip.sourceUrl)
  if (clips.length === 0) throw new Error('AI 档没有可用分镜素材')
  /**
   * 输出帧率。★★ 声明位置必须在**所有读取点之前**（2026-09-22 线上事故的教训）。
   *
   * 本函数体有 700+ 行，它原先躺在 1300 行开外，而更早处的 `clips.map(...)` 闭包
   * 就已经在算镜头时长、间接读到它 ⇒ 抛 `Cannot access 'fps' before initialization`（TDZ），
   * 线上每次 AI 档合成都失败。
   * 时长计算那段已整段搬到 `chatcut-timing.ts`（fps 变入参），但本函数体内**仍有**
   * `framesOf(…, fps)` 散布在 TTS / 排轨 / 转场通知里 ⇒ 保留「一进函数就声明」这条纪律。
   */
  const fps = input.output.fps
  const notices: string[] = []
  // ★★ pacePlan / transitionPlan 已**下移**到下面「AI 剪辑决策（EDL）」之后 —— 见「有效选项」那段。
  //   原因：这两个值由档位映射而来，而档位现在可能被 AI 的决策覆盖 ⇒ 必须先拿到决策再映射。
  //   ⚠ 下移是安全的：在 EDL 之前**没有任何地方读它们**（第一次读是 planShotTiming）。
  safePhase(input, 0.02, '准备项目')

  const project = await createChatCutProject({
    name: input.title || `大帅餐饮成片-${input.taskId}`,
    width: input.output.width,
    height: input.output.height,
    fps: input.output.fps,
    description: input.options.note || undefined,
  })
  const projectId = project.projectId
  const videoTrackId = project.trackIds[0]
  safePhase(input, 0.08, '已创建项目')

  // ── 1) 分镜素材：直接推 COS 原始字节（不本地转码，画布适配交给 fit:"cover"）
  const clipSources = await Promise.all(
    clips.map(async (clip, index) => {
      const source = await remoteSource(clip.sourceUrl, `shot-${index + 1}.mp4`, 'video/mp4', clip.durationMs)
      // 顺手回填素材表宽高，后续任务零探测成本（失败不影响合成）
      await backfillClipMeta(clip.assetId, source.meta).catch(() => undefined)
      return source
    }),
  )
  safePhase(input, 0.16, `素材已探明（${clips.length} 段）`)

  // ★ 每个分镜的**真实素材时长**（探测所得）。时间轴一律以它为准，不用客户端上报的取整值 ——
  //   上报 3000ms / 真实 2968ms，按上报值排帧必被 ChatCut 拒单（见 framesOf 的注释）。
  const clipAssetMs = clipSources.map((source) => {
    const sec = source.meta?.durationInSeconds
    return typeof sec === 'number' && sec > 0 ? Math.round(sec * 1000) : null
  })
  /**
   * 镜头时长规划整段（真实时长 ∧ trim ∧ 转场余量 ∧ 节奏档位）—— 已搬到 `chatcut-timing.ts`。
   *
   * ★★ 为什么它不能再写在本函数体内（2026-09-22 线上事故）：
   *   这一串闭包互相引用，而 `slotMs` 在 `const fps = input.output.fps` **之前**就被
   *   `clips.map()` 求值：slotMs → scaledShotMs → rawShotMs → handleMsOf → `… / fps`。
   *   于是每一次 AI 档合成都抛 `Cannot access 'fps' before initialization`（TDZ）。
   *   ⇒ 搬成纯函数后 `fps` 是**入参**、且在函数体第一行绑定，结构上不可能再「先用后声明」。
   *
   * ★★ 别把这段挪回来。本函数体有 700+ 行，闭包跨几百行引用外层 `const` 时：
   *   · typecheck **不报**（那个函数可能永远不在声明前被调用，静态无法判定）；
   *   · 构建成功、部署也成功；**只有真实跑一次任务才炸**。
   *   这类缺陷只能靠 `scripts/verify-chatcut-timing.ts` 那种「真的算一遍」的闸门守住。
   *
   * ★ 传进去的是**值**（handleFrames / shotScale / minShotMs），档位表仍然只有 chatcut.ts 一份。
   */
  // ────────────────────── AI 剪辑决策（EDL）──────────────────────
  // 位置是**唯一可行**的：必须在**素材探测之后**（要把每段的真实时长喂给模型，
  // 它才知道每个镜头物理上最多能留多长），且必须在**排轨之前**
  // （决策决定档位 ⇒ 档位决定镜头时长与转场余量 ⇒ 余量决定排帧）。
  const plan = await generateEditPlan({
    merchantId: input.merchantId,
    taskId: input.taskId,
    shots: clips.map((clip, index) => ({
      line: clip.line ?? null,
      assetMs: clipAssetMs[index] ?? null,
      durationMs: clip.durationMs ?? null,
    })),
    prefer: {
      pacing: input.options.pacing,
      transitions: input.options.transitions,
      subtitleStyle: input.options.subtitleStyle,
      bgm: input.options.bgm,
    },
    note: input.options.note,
  })
  // ★ notice 只进日志与进度文案：`generateEditPlan` 从不抛错，最坏就是「按面板档位剪」。
  if (plan.notice) notices.push(plan.notice)
  safePhase(input, 0.18, plan.edl ? 'AI 剪辑决策完成' : '按面板档位剪')

  /**
   * ★★ 有效选项：AI 决策成功时覆盖整片的四个档位；否则**就是 `input.options` 本身**。
   *
   * ⚠ 下面读档位的地方一律读 `options` —— 别再写 `input.options`。
   *   混读会产生「节奏用了 AI 的、字幕还在用面板的」这种**半覆盖**状态，且不会报错。
   * ★ `plan.edl` 为 null 的三条路径（开关关 / 调用失败 / 解析不出 JSON）都落到
   *   `input.options`，于是行为与引入本功能之前**逐字段一致** ⇒
   *   「不改变原有 AI 生成路线」这条约束在代码层面成立，而不是靠约定。
   */
  const options: ChatCutOptions = plan.edl
    ? {
        ...input.options,
        pacing: plan.edl.pacing,
        transitions: plan.edl.transitions,
        subtitleStyle: plan.edl.subtitleStyle,
        bgm: plan.edl.bgm,
      }
    : input.options

  /**
   * 剪辑节奏档位的落地参数。
   * ★ 只在「排轨之前」用它：`shotScale` 必须**在算镜头时长时就生效**（见 scaledShotMs），
   *   而不是排完轨再回头改 —— 回头改会在轨道上留下空隙，而 close-gap 只能用
   *   `edit_track tighten`，那个是**按轨**关缝、会让 A1 的配音相对 V1 整体错位。
   */
  const pacePlan = PACING_PLANS[options.pacing]
  /**
   * 转场档位的落地计划（含「每个镜头要预留多少素材」）。
   * ★ 它必须在**排轨之前**就参与镜头时长的计算，理由见 chatcut-timing.ts 里 handleFramesOf 的注释 ——
   *   这是实测出来的关键约束，不是可选的优化。
   */
  const transitionPlan = TRANSITION_PLANS[options.transitions]

  const timing = planShotTiming({
    clips,
    clipAssetMs,
    fps: input.output.fps,
    transitionHandleFrames: transitionPlan.handleFrames,
    pacingShotScale: pacePlan.shotScale,
    pacingMinShotMs: pacePlan.minShotMs ?? 0,
    // ★ 逐镜头目标时长：null = 该镜头没有 AI 指令 ⇒ 仍按上面的节奏档位缩放。
    //   ⚠ 这里传的是 `plan.edl`（AI 的原始决策），**不是**夹取后的值 —— 严夹在
    //     chatcut-timing.ts 的 scaledShotMs 里做（只有那里知道每段素材的可用时长）。
    edlShotMs: toEdlShotMs(plan.edl, clips.length),
  })
  const handleFrames = timing.handleFrames
  const handleMsOf = timing.handleMsOf
  const rawShotMs = timing.rawShotMs
  const scaledShotMs = timing.scaledShotMs
  // ★ 下面 TTS 段会按下标改写它（配音比目标时长更长时抬高镜头）⇒ 必须保持**同一个数组引用**
  const slotMs = timing.slotMs

  /**
   * 响度探测：与下面的配音合成**并行**发起（两者都是网络 I/O，串起来白白多等一轮）。
   * 只有用户勾了「统一音量」才做 —— 每段素材都要被 ffmpeg 完整解一遍音频，不便宜。
   * ★ 单个失败一律 `null`（＝这一段不调整），绝不让「测不了响度」变成「出不了片」。
   */
  const clipLufsPromise: Promise<Array<number | null>> = input.options.normalizeAudio
    ? Promise.all(clips.map((clip) => probeLoudnessLufs(clip.sourceUrl).catch(() => null)))
    : Promise.resolve(clips.map(() => null))

  // ── 2) 配音：逐镜头合成，时长对齐该镜头（与本地管线的语义一致）
  //    ★ 选了「不配音」就整个跳过：不加音轨 = 保留素材自带原声。
  //      第 4 步排轨只 add 了 `type:'video'`，没有 mute 参数 ⇒ 视频条目的原声本来就在，
  //      之前那版之所以「只剩画面」是**多了一条静音配音轨**，不是原声被抹了。
  const voiceOff = input.options.voiceId === CHATCUT_VOICE_OFF
  const dir = await mkdtemp(join(tmpdir(), 'dashuai-chatcut-'))
  const voiceSources: ChatCutUploadSource[] = []
  const voiceSpans: Array<{ index: number; fromFrame: number; durationInFrames: number }> = []
  /** 分镜下标 → 该段配音的实测响度（LUFS）。只填「真的合成了配音」的那些下标。 */
  const voiceLufs = new Map<number, number | null>()
  let cursorFrame = 0
  try {
    // voiceOff 时不去查 TTS 供应商：查了只会多打一条「未配置 TTS 供应商」的误导 notice
    const provider = voiceOff ? null : await activeTtsProvider(prisma).catch(() => null)
    const speaker = VOICE_ENV_KEYS[input.options.voiceId]
      ? process.env[VOICE_ENV_KEYS[input.options.voiceId]!]?.trim()
      : undefined
    const voiceOverride = speaker && provider ? { ...provider, voiceId: speaker } : provider
    if (voiceOff) notices.push('已选择「不配音」⇒ 使用画面原声；字幕一并关闭（字幕由配音轨转录派生）')
    else if (!provider) notices.push('未配置 TTS 供应商 ⇒ 只出画面与字幕，没有配音')
    // ★ 判据从「有指定音色」放宽到「有没有 apiKey」：`synthesizeNarration` 的兜底是
    //   「provider 或 apiKey 缺失 ⇒ 本地生成**静音轨**」，与有没有指定音色无关。
    //   漏掉这一种情况的话，线上会得到「有配音轨、但整条是静音、而且一个字幕都没有」的片子，
    //   而日志里**一句提示都没有**（这个坑本轮就是这么发现的：上一轮干跑的 voice-*.m4a 全是静音）。
    else if (!provider.apiKey) notices.push('TTS 供应商缺 apiKey ⇒ 配音为静音轨（字幕也会是空的）')

    for (let index = 0; index < clips.length; index += 1) {
      const clip = clips[index]!
      // 没有旁白（或选了不配音）的镜头：直接按节奏档位排，不需要为配音让路
      if (voiceOff || !clip.line?.trim() || slotMs[index]! <= 0) {
        cursorFrame += framesOf(slotMs[index]!, fps)
        continue
      }
      const outPath = join(dir, `voice-${index + 1}.m4a`)
      // ★★ 合成目标用 **rawShotMs**（原始可用时长），不是缩放后的 slot：
      //    `synthesizeNarration` 对齐时长的做法是「apad 补静音 + -t 硬截断」，
      //    如果直接把缩放后的短时长丢给它，台词会被**从中间切掉**（而且是静默的）。
      //    先把这句话完整地生成出来，再按下面的规则决定镜头上到底留多长。
      const synthMs = rawShotMs(index)
      await synthesizeNarration(clip.line, synthMs, outPath, voiceOverride, 90_000)
      safePhase(input, 0.16 + 0.34 * ((index + 1) / clips.length), `配音 ${index + 1}/${clips.length}`)

      // ── 剪辑节奏的「配音下界」：镜头可以缩，但不能缩到比这句话还短
      // ★★ 判据必须**包含**「这个镜头被 EDL 缩短了」这一种情况：
      //    EDL 的逐镜头时长与用户选的节奏档位**彼此独立** —— 用户完全可能选 NATURAL
      //    （shotScale=1，下面这个条件原本不成立），而 AI 把某个镜头砍到 2 秒。
      //    漏掉它 ⇒ 那句台词会被 `synthesizeNarration` 的 `-t` 参数**静默截断**
      //    （它是「apad 补静音 + 硬截断」，从中间切掉，日志里没有任何提示）。
      // ★ 无 EDL 时 `scaledShotMs(index) === rawShotMs(index)` ⇒ `wantedShorter` 恒为 false
      //    ⇒ 本条件与引入 EDL 之前**完全等价**（不是「近似等价」）。
      //    `-1` 是毫秒容差：`Math.round` 之后可能差 1ms，不该因此多跑一轮变速。
      const wantedShorter = scaledShotMs(index) < rawShotMs(index) - 1
      if (pacePlan.shotScale < 1 || wantedShorter) {
        // 尾部静音就是 `apad` 补出来的那段 ⇒ 它能告诉我们语音真正在哪里结束
        const speechMs = await probeSpeechEndMs(outPath).catch(() => null)
        if (speechMs !== null && speechMs > 0) {
          const wanted = scaledShotMs(index)
          const margin = VOICE_TAIL_MARGIN_MS
          if (speechMs + margin > wanted) {
            const tempo = speechMs / Math.max(1, wanted - margin)
            if (tempo > MAX_SPEECH_TEMPO) {
              // 语速提太多就不像人话了 ⇒ 宁可少缩一点，也不能把台词吃掉
              slotMs[index] = Math.min(synthMs, speechMs + margin)
            } else {
              // 提到「刚好放得下」的语速（atempo 保音高），然后整段重新对齐到目标时长
              slotMs[index] = wanted
              await retimeAudioTo(outPath, wanted, tempo)
            }
          } else {
            // 这句话本来就短 ⇒ 只把多余的尾部静音裁掉即可，语速不用动
            await retimeAudioTo(outPath, wanted)
          }
        }
      }

      // ★★ 必须把字节读进内存，**不能**留 `createReadStream(outPath)` 这种「延迟打开」：
      //    上面那个 `finally` 里 `dir` 在 TTS 循环一结束就整个删掉了，而真正推字节
      //    （`importAssets` → `putStream`）发生在那之后 ⇒ 延迟 open 会去读一个**已删除**的
      //    路径；`createReadStream` 不抛错、只异步 emit error，被 undici 包装成一句毫无线索的
      //    `TypeError: fetch failed`（真因 ENOENT 藏在 `cause` 里）。
      //    实测任务 990026 就是这么失败的，合成复现见本轮排查记录。
      //    配音 m4a 只有几十 KB，缓存进内存零成本，而且 `open()` 可重复调用（PUT 重试要用）。
      const bytes = await readFile(outPath)
      // 配音的**真实音频时长**：metadata 声明必须用它，占位还得跟它取小 ——
      // 占位超过音频素材，会和视频那条一样被 ChatCut 拒单（`Source range exceeds … asset duration`）
      // ⚠ 必须在上面 retime 之后才测（retime 会改文件时长）
      const voiceMs = (await probeDurationMs(outPath)) ?? slotMs[index]!
      // 响度探测必须在读文件之前、`rm(dir)` 之前做完（探测要读这个本地文件）
      if (input.options.normalizeAudio) {
        voiceLufs.set(index, await probeLoudnessLufs(outPath).catch(() => null))
      }
      voiceSources.push({
        filename: `voice-${index + 1}.m4a`,
        contentType: 'audio/mp4',
        assetType: 'audio',
        size: bytes.length,
        open: () => Readable.from(bytes),
        meta: { durationInSeconds: voiceMs / 1000 },
        // ★ 只有配音轨要 ASR：字幕就是从它的转录派生的（分镜素材开转录纯属烧额度）
        startTranscription: input.options.subtitles,
      })
      const slotFrames = framesOf(slotMs[index]!, fps)
      voiceSpans.push({
        index,
        fromFrame: cursorFrame,
        // 取小：超过音频素材会被拒单，超过分镜时长会盖到下一个镜头的配音
        durationInFrames: Math.max(1, Math.min(slotFrames, framesOf(voiceMs, fps))),
      })
      cursorFrame += slotFrames
    }
  } finally {
    // 字节已经被推上去了（流式读完），文件可以删
    await rm(dir, { recursive: true, force: true })
  }

  // ── 3) 一次导入全部素材（每 4 个开一个上传会话，importAssets 内部处理）
  //    上传是最慢的一步（要把全部原始字节推给 ChatCut），前后各报一次让进度可见
  safePhase(input, 0.55, '上传素材')
  const imported = await importAssets(projectId, [...clipSources, ...voiceSources])
  safePhase(input, 0.85, '素材已上传')
  const assetIdOf = (filename: string): string => {
    const found = imported.find((item) => item.filename === filename)
    if (!found) throw new Error(`素材 ${filename} 导入失败`)
    return found.assetId
  }

  // ── 4) 排轨：视频链式；配音按镜头时间轴落在 A1
  const adds: Array<Record<string, unknown>> = []
  let timelineFrame = 0
  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index]!
    const assetId = assetIdOf(`shot-${index + 1}.mp4`)
    const trimStartMs = clip.trimStartMs ?? 0
    // ★ 用 `slotMs`（节奏档位 ∧ 配音下界之后的最终值）—— 它同时也是上面 cursorFrame
    //   累加用的那个值，两处必须同源，否则 A1 的配音会与 V1 的画面整体错位。
    //   旧写法用客户端上报的 durationMs 排帧 ⇒ 90 帧 vs 2.968s，被 ChatCut 直接拒单。
    const durationMs = slotMs[index]!
    const durationFrames = durationMs > 0 ? framesOf(durationMs, fps) : undefined
    // ★★ 素材起点要**跳过转场预留的头部余量**：时长少算了 2×handle，起点就必须往后挪 handle，
    //    否则 source 范围变成 [trimStart, trimStart + 短时长)，尾部多出来的那截 handle 就白留了
    //    （转场仍然会因「尾部无余量」被拒）。
    //    这样算出的 source 范围 = [trimStart+handle, end−handle] ⊂ 素材，天然不会越界。
    const sourceStartMs = trimStartMs + handleMsOf(index)
    adds.push({
      type: 'video',
      assetId,
      fromFrame: timelineFrame,
      ...(durationFrames ? { durationInFrames: durationFrames } : {}),
      ...(sourceStartMs > 0 ? { sourceStartFromInSeconds: sourceStartMs / 1000 } : {}),
      // 画布是 9:16，原始素材比例未知 ⇒ cover 裁切填满，不出现黑边
      fit: 'cover',
      // 「舒缓」档要求镜头自身带首尾淡入淡出（`fade*` 的单位是**秒**，不是帧 ——
      // 文档明确警告别把 0.3 秒写成 30）。0 表示不加，所以只在档位要求时才带这两个字段。
      ...(pacePlan.clipFadeSec > 0
        ? { fadeIn: pacePlan.clipFadeSec, fadeOut: pacePlan.clipFadeSec }
        : {}),
      ...(videoTrackId ? { trackId: videoTrackId } : {}),
    })
    timelineFrame += durationFrames ?? 0
  }
  for (const span of voiceSpans) {
    adds.push({
      type: 'audio',
      assetId: assetIdOf(`voice-${span.index + 1}.m4a`),
      fromFrame: span.fromFrame,
      durationInFrames: span.durationInFrames,
      // ★ 用别名 A1：轨道不存在时 edit_item 会自动建（实测 createdNewTrack:true）
      trackId: 'A1',
    })
  }
  const added = await addChatCutItems(projectId, adds)
  safePhase(input, 0.95, '排轨完成')

  // ── 5) 人声轨设为 anchor（引擎据此让 follower 轨自动闪避；不设则谁都不让位）
  //
  // ★ `create_project` 建出来的 V1 **默认就带 `audioDucking:{role:"anchor"}`**（实测），
  //   所以「有配音」时我们得把 anchor 挪到真正的人声轨 A1 上：
  //   BGM 是 follower，它「让位给谁」由谁被标成 anchor 决定 —— 让位给 V1 的素材原声、
  //   而不是让位给旁白，闪避方向就整个错了。无配音时画面原声就是人声，V1 的默认 anchor 正好。
  const audioTrackId = [...JSON.stringify(added).matchAll(/"trackId":"([0-9a-f]{8,})"/g)]
    .map((match) => match[1]!)
    .find((id) => id !== videoTrackId)
  if (audioTrackId && voiceSpans.length > 0) {
    await setChatCutTrackRole(projectId, audioTrackId, 'anchor').catch((error) => {
      notices.push(`人声轨 anchor 设置失败（自动闪避不生效）：${(error as Error).message}`)
    })
  }

  // ── 6) 打磨：转场 → 统一音量 → 消爆音。全部「失败只记 notice」，绝不阻塞出片。
  //    ★ 必须排在这一步（排轨之后、导出之前）：转场要引用已存在的 item id，
  //      而 item id 只能从 `preview_timeline` 拿（见 previewChatCutTimeline 的注释）。
  //    ★ 转场预留的素材**不会出现在片子里** ⇒ 整片会变短。这件事必须让用户知情
  //      （不然「选了转场，片子怎么短了」是个无法解释的现象）。
  if (transitionPlan.handleFrames > 0) {
    const reserved = handleFrames.reduce((sum, value) => sum + value, 0)
    if (reserved > 0) {
      notices.push(`为转场预留了素材 ⇒ 整片约缩短 ${((reserved * 2) / fps).toFixed(1)}s（转场用它做过渡）`)
    }
  }
  try {
    const clipLufs = await clipLufsPromise
    await polishChatCutTimeline(
      {
        projectId,
        transitionPlan,
        handleFrames,
        normalizeAudio: input.options.normalizeAudio,
        clipLufs,
        voiceLufs,
        hasVoice: voiceSpans.length > 0,
      },
      notices,
    )
  } catch (error) {
    // polishChatCutTimeline 内部已逐步兜错；这里兜的是它自己没预期到的（例如 await 前抛）
    notices.push(`打磨阶段整体失败（本片未做转场/音量统一）：${(error as Error).message}`)
  }

  // ── 7) BGM：这一步只**提交生成**；真正排轨要等生成就绪（分钟级），在 PREPARE 阶段做
  //        （见 placeChatCutBgm / pollChatCutRender）。
  //    默认关闭：生成音乐是**消耗 ChatCut 额度**的调用，留作运维开关 `CHATCUT_BGM_ENABLED`。
  const bgmChoice = options.bgm
  let bgmJobId: string | undefined
  if (bgmChoice !== 'NONE') {
    if (!chatCutBgmEnabled()) {
      notices.push(`已选 BGM=${bgmChoice}，但 CHATCUT_BGM_ENABLED 未开 ⇒ 本次无背景音乐`)
    } else {
      try {
        const job = await callTool('submit_music', {
          generationType: 'instrumental',
          prompt: BGM_PROMPTS[bgmChoice],
          name: 'dashuai-bgm',
          projectId,
        })
        bgmJobId = pickString(job, 'jobId', 'job_id', 'id') ?? jobIdFromText(resultText(job))
        notices.push(
          bgmJobId
            ? `BGM 已提交生成（jobId=${bgmJobId}）；生成完成后自动排到人声轨下方并做闪避`
            : 'BGM 已提交，但返回里没有 jobId ⇒ 无法自动排轨（需人工在编辑器放置）',
        )
      } catch (error) {
        notices.push(`BGM 生成提交失败：${(error as Error).message}`)
      }
    }
  }

  const state: ChatCutJobState = {
    projectId,
    timelineId: project.timelineId,
    editorUrl: project.editorUrl,
    uploadAssetIds: imported.map((item) => item.assetId),
    transcriptionAssetIds: voiceSources.filter((source) => source.startTranscription).map((source) => assetIdOf(source.filename)),
    phase: 'PREPARE',
    prepareStartedAtMs: Date.now(),
    subtitleStyle: options.subtitleStyle,
    removeSilence: input.options.removeSilence,
    notices,
    ...(bgmJobId ? { bgmJobId, bgmStartedAtMs: Date.now() } : {}),
  }
  safePhase(input, 1, '启动完成，转入云端渲染')
  return { status: 'RUNNING', state }
}

/**
 * 「还在跑」的状态词（`progressState` 的判据之一）。
 * ★ 存在的理由：状态**词**比 `ok` 布尔可信 —— 实测 generation 的 processing 期间
 *   `ok:true`（同一条里 status 是 'processing'），只认 ok 就会把没跑完的任务当成已就绪。
 */
const RUNNING_STATUSES = ['processing', 'running', 'pending', 'queued', 'in_progress', 'submitted', 'waiting']

/**
 * 就绪判定。实测返回形如
 *   { entries:[{id,name,status:"ready"|"pending"|…,ok,terminal,error,progress}], success, terminal }
 * 三态：全就绪 / 有终态失败 / 还需等。
 * ★ 宁可「还需等」也不要误判就绪 —— 前置没就绪就提交导出，会得到一个慢慢跑或者直接失败的渲染。
 *
 * ★★ 但「还需等」也有一条硬线：**`terminal:false` 就是没就绪**（2026-09-21 实测）。
 *   生成类任务的条目长这样：
 *     { id, ok:true, outputAssetId:null, progress:30, status:'processing', terminal:false }
 *   —— 注意 **`ok:true`**！它只表示「这条任务记录本身没问题」，processing 期间也是 true。
 *   旧写法把 `entry.ok === true` 直接当成就绪 ⇒ 一个**刚提交 30 秒**的音乐任务会被判成
 *   「已完成」，于是去取 `outputAssetId`（还是 null）⇒ 记一句「取不到素材」就收工，
 *   BGM **永远排不上轨且不报错**。所以这里把判据按权威程度重排：
 *     ① `terminal:false` / 状态词是运行中 ⇒ 否定
 *     ② 状态词命中就绪集合 ⇒ 肯定
 *     ③ 都没有时，才退回「ok:true 且**没有正在运行的迹象**」
 */
function progressState(value: Record<string, unknown>): 'ready' | 'failed' | 'waiting' {
  const entries = resultEntries(value)
  if (entries.length === 0) return 'waiting'
  const statusOf = (entry: Record<string, unknown>): string => (pickString(entry, 'status') ?? '').toLowerCase()
  const failed = entries.some((entry) => {
    const status = statusOf(entry)
    return entry.ok === false || Boolean(entry.error) || ['failed', 'error', 'cancelled', 'canceled'].includes(status)
  })
  if (failed) return 'failed'
  const ready = entries.every((entry) => {
    const status = statusOf(entry)
    if (entry.terminal === false) return false
    if (entry.terminal === true) return true
    if (RUNNING_STATUSES.includes(status)) return false
    return ['ready', 'completed', 'complete', 'done', 'success', 'succeeded'].includes(status) || (status === '' && entry.ok === true)
  })
  return ready ? 'ready' : 'waiting'
}

/**
 * 取远端 `track_progress` 的**条目均值进度**（0~1）。
 * entries 里每条自带的 `progress` 实测就是 0~1（ready 时 = 1）；拿不到就返回 0 ——
 * 进度停在阶段起点，绝不倒退。
 */
function averageProgress(value: Record<string, unknown>): number {
  const ratios = resultEntries(value)
    .map((entry) => Number(entry.progress))
    .filter((n) => Number.isFinite(n) && n >= 0)
  if (ratios.length === 0) return 0
  return Math.max(0, Math.min(1, ratios.reduce((sum, n) => sum + n, 0) / ratios.length))
}

/** 从「建/改轨」的返回里收集**轨道 id**。判据是「这个对象同时有 id 与轨道特征字段」—— 避免把 timelineId / itemId 也收进来。 */
function trackIdsFromResponse(value: unknown): string[] {
  const found: string[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    const record = node as Record<string, unknown>
    const id = pickString(record, 'id', 'trackId')
    if (
      id &&
      (record.trackType !== undefined || record.alias !== undefined || record.audioDucking !== undefined)
    ) {
      found.push(id)
    }
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') visit(child)
    }
  }
  visit(value)
  return found
}

/**
 * 建一条音频轨，返回它的**稳定 id**。
 * ★ 为什么不能拿别名（A2 之类）去用：文档明确说别名在插入轨道后会移位（V1/V2 会重排），
 *   所以建完必须立刻把稳定 id 记下来交给后续 `edit_item`。
 * ★ `role='follower'` 必须在**建轨时**就给：follower 是「会被自动压低的那条轨」，
 *   而 anchor（人声）此时已经是 A1 —— 两者成对才产生闪避（见 chatcut.ts 的注释）。
 */
/**
 * 建一条音频轨，返回它的**稳定 id**。
 * ★ 为什么不能拿别名（A2 之类）去用：文档明确说别名在插入轨道后会移位（V1/V2 会重排），
 *   所以建完必须立刻把稳定 id 记下来交给后续 `edit_item`。
 * ★ `role='follower'` 必须在**建轨时**就给：follower 是「会被自动压低的那条轨」，
 *   而 anchor（人声）此时已经是 A1 —— 两者成对才产生闪避（见 chatcut.ts 的注释）。
 *
 * ★★ 取 id 的判据（2026-09-21 实测校准）：`edit_track create` 的返回**本身就是新建那条轨**：
 *   `{"id":"45a3587ef3","name":"A3","order":3,"trackType":"audio","tracks":[ … 全部轨道 … ]}`
 *   —— 顶层 `id` 就是要的那个（注意它是**10 位短前缀**，与 `preview_timeline` 的完整 UUID
 *   不是同一种写法；两者都能被下游接受，实测用前缀 `trackId` 排轨成功）。
 *   ⚠ 老的「在 tracks 里找一条不在 knownTrackIds 里的」这个启发式**是错的**：
 *     返回里的 id 是前缀、而 knownTrackIds 是完整 UUID ⇒ 谁都不匹配 ⇒ 会挑中**第一条轨（V1）**，
 *     把音乐排到视频轨上。所以它只留作最末的兜底，且比较时必须按前缀匹配。
 */
async function createChatCutAudioTrack(
  projectId: string,
  name: string,
  role: 'follower',
  knownTrackIds: string[],
): Promise<string | undefined> {
  const value = await callTool('edit_track', {
    projectId,
    action: 'create',
    json: JSON.stringify({ trackType: 'audio', name, role }),
  })
  // ① 首选：返回体顶层的 id 就是新建轨
  const created = parseEmbeddedJson(value)
  const direct = created ? pickString(created, 'id', 'trackId') : undefined
  if (direct) return direct
  // ② 兜底：从返回里收集轨道 id，排除已知的那些（**按前缀**比较两侧写法不一致的情况）
  const known = new Set(knownTrackIds.map((id) => id.slice(0, 10)))
  return trackIdsFromResponse(value).find((id) => !known.has(id.slice(0, 10)))
}

/**
 * 从人话文本里抠出**嵌在里面的 JSON 对象**（取第一个 `{` 到最后一个 `}`）。
 *
 * ★★ 为什么需要它（2026-09-21 实测 `edit_track create`）：
 *   `content[].text` 的原文是 `<JSON 正文>\n\nCaption notice: this edit may have made …`
 *   —— 后面**还跟了一段人话**，所以 `extractStructured()` 里的 `JSON.parse(整段)` 必然失败，
 *   它会退回 `structuredContent`，而那里**没有轨道数据**（只有 editorUrl / browserHandoff
 *   这类宿主上下文）。于是结构化的轨道 id 谁都看不到 ⇒ `trackIdsFromResponse` 收空集
 *   ⇒ 建轨成功却「取不到轨道 id」，BGM 排不上轨。
 * ⚠ 不能改成「先把 message 当 JSON 解」——这条路上两种形态都有（纯 JSON / JSON+人话）。
 */
function parseEmbeddedJson(value: Record<string, unknown>): Record<string, unknown> | null {
  const text = resultText(value)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // 不是 JSON：交给调用方按字段名/正则兜
  }
  return null
}

/**
 * 从 `track_progress {target:'generation'}` 的返回里取**生成出来的项目素材 id**。
 *
 * ★★ 实测形状（2026-09-21，用一个真提交的 instrumental 任务拉到的原文）：
 *   processing 期间：`{ entries:[{ id:'75d11fa728', name:'dashuai-bgm', ok:true,
 *                                  outputAssetId:null, progress:30, status:'processing',
 *                                  terminal:false, error:null, target:'generation' }],
 *                       success:true, terminal:false, checkBackAfterSeconds:30 }`
 *   ⇒ 素材 id 的字段名是 **`outputAssetId`**，不是 `assetId` / `asset.id`。
 *     按后者找会永远取不到 ⇒ 表现为「BGM 生成成功但排不上轨」，而且**不报错**。
 *   ⇒ 另外 `ok:true` 在 processing 期间也是 true（它只表示任务记录本身没问题），
 *     所以**不能**用 ok / success 判断完成（见 progressState 的注释）。
 */
function assetIdFromGeneration(value: Record<string, unknown>): string | undefined {
  const top = pickString(value, 'outputAssetId', 'output_asset_id')
  if (top) return top
  for (const entry of resultEntries(value)) {
    const direct = pickString(entry, 'outputAssetId', 'output_asset_id', 'assetId', 'asset_id')
    if (direct) return direct
    for (const key of ['asset', 'result', 'output']) {
      const nested = entry[key]
      if (nested && typeof nested === 'object') {
        const id = pickString(nested as Record<string, unknown>, 'assetId', 'asset_id', 'id')
        if (id) return id
      }
    }
  }
  // 兜底：终态把 id 写在**人话文本**里（本项目其他工具确有这种形态，见 resultText 的注释）
  const text = resultText(value)
  const match =
    text.match(/"?output_?asset_?id"?\s*[:=]\s*"?([0-9a-z-]{8,})"?/i) ??
    text.match(/\b(?:assetId|asset_id)\s*[:=]\s*"?([0-9a-f-]{8,})"?/i)
  return match?.[1]
}

/**
 * 片子的**内容长度**（帧）= 视频链最后一个 item 的结束帧。
 *
 * ★★ 为什么不能拿 `view.durationFrames`：那个值是「时间线上最长的东西」——
 *   一旦某条轨上有超出片长的 item（比如上一轮排进来的长 BGM），它就跟着撑大。
 *   而视频链的长度才是片子的真实长度，与别人的状态无关。
 */
function filmFramesOf(view: ChatCutTimelineView): number {
  const shots = orderShotItems(view.entries)
  const last = shots[shots.length - 1]
  return last && last.toFrame > 0 ? last.toFrame : view.durationFrames
}

/**
 * 把已生成好的音乐排到时间线上：从 0 帧铺到**片子结束**。
 *
 * ★★ 必须显式给 `durationInFrames`（2026-09-21 读回时间线才发现的坑）：
 *   省略时长时远端按**素材自身时长**铺 —— 而生成的 BGM 通常 2~3 分钟，
 *   于是时间线被这条音轨**撑长**（实测：984 帧的片子被一条 `dashuai-bgm.mp3`
 *   顶成 5039 帧 = 168 秒，V1 上后面全是空档）。导出是按时间线长度渲的 ⇒
 *   出来会是一支几百秒、后半段全黑的片子。
 *   ⚠ 旧注释「音乐比片子长没关系，导出只取时间线长度」是**错的**：那句话预设
 *     时间线长度由视频决定，而实测它取的是**最长 item**。
 * ★ `audioFadeIn/Out` 单位是**秒**（不是帧）：结尾硬切会「啪」一下，2 秒淡出干净得多。
 */
async function placeChatCutBgm(
  projectId: string,
  assetId: string,
  trackId: string,
  durationFrames: number,
): Promise<void> {
  await callTool('edit_item', {
    projectId,
    adds: [
      {
        type: 'audio',
        assetId,
        fromFrame: 0,
        ...(durationFrames > 0 ? { durationInFrames: durationFrames } : {}),
        trackId,
        audioFadeIn: 1,
        audioFadeOut: 2,
      },
    ],
  })
}

interface BgmAdvance {
  /** true = 已处理完（成功或明确放弃），可以继续走导出；false = 还在生成，本轮先别导出 */
  done: boolean
  patch?: Partial<Pick<ChatCutJobState, 'bgmJobId' | 'bgmPlaced' | 'bgmTrackId'>>
}

/**
 * PREPARE 阶段推进 BGM 生成：查进度 → 就绪则建轨并排轨。
 *
 * ★ 与转录一样是**带预算的软等待**（`BGM_WAIT_MS`）：超预算就放弃 BGM 直接出片。
 *   绝不允许「音乐一直生成不出来」把片子拖到 30 分钟被 sweeper 退款 ——
 *   那才是真正的失败（用户一分钱没花，但也没拿到片子）。
 * ★ 任何失败都写 `bgmPlaced:true` 收尾，避免每轮 tick 都重打同一条失败。
 */
async function advanceChatCutBgm(state: ChatCutJobState, notices: string[]): Promise<BgmAdvance> {
  if (!state.bgmJobId || state.bgmPlaced) return { done: true }

  let value: Record<string, unknown>
  try {
    value = await callTool('track_progress', {
      action: 'status',
      target: 'generation',
      jobIds: state.bgmJobId,
      projectId: state.projectId,
    })
  } catch (error) {
    notices.push(`查 BGM 生成进度失败 ⇒ 本片不带背景音乐：${(error as Error).message}`)
    return { done: true, patch: { bgmPlaced: true } }
  }

  const progress = progressState(value)
  if (progress === 'failed') {
    notices.push('BGM 生成失败 ⇒ 本片不带背景音乐出片')
    return { done: true, patch: { bgmPlaced: true } }
  }

  /**
   * ★★ 就绪判据 = **拿到 asset id**，不是「状态看起来完了」（2026-09-21 实测校准）。
   *   实测 processing 期间就有 `ok:true` / `success:true`，只有 `terminal:false` 与
   *   `status:'processing'` 说明没跑完；而 asset id（`outputAssetId`）**只在终态出现**。
   *   ⇒ 所以这一段完全不依赖 `progressState` 的 ready 结论，只认「有没有 id」：
   *     没 id 就继续等（受 BGM_WAIT_MS 预算兜住），这样即使状态字段将来又变，
   *     也不会出现「被判成已完成 → 取不到 id → 以为排过轨了」这种静默丢配乐。
   */
  const assetId = assetIdFromGeneration(value)
  if (!assetId) {
    const waited = Date.now() - (state.bgmStartedAtMs ?? Date.now())
    if (progress !== 'ready' && waited < BGM_WAIT_MS) return { done: false }
    notices.push(
      progress === 'ready'
        ? 'BGM 生成已就绪但未取到素材 id ⇒ 未自动排轨（需人工在编辑器放置）'
        : `BGM 生成等待超过 ${Math.round(BGM_WAIT_MS / 1000)}s ⇒ 本片不带背景音乐出片`,
    )
    return { done: true, patch: { bgmPlaced: true } }
  }

  try {
    // ★ 无论要不要建轨都要读一次时间线：**片长必须现算**（见 placeChatCutBgm 的注释），
    //   而且只有在「排 BGM 之前」读到的视频链长度才是干净的片子长度。
    const view = await previewChatCutTimeline(state.projectId)
    let trackId = state.bgmTrackId
    if (!trackId) {
      trackId = await createChatCutAudioTrack(
        state.projectId,
        'BGM',
        'follower',
        view.tracks.map((track) => track.id),
      )
    }
    if (!trackId) {
      notices.push('BGM 轨已建但未取到轨道 id ⇒ 未自动排轨（需人工在编辑器放置）')
      return { done: true, patch: { bgmPlaced: true } }
    }
    const durationFrames = filmFramesOf(view)
    await placeChatCutBgm(state.projectId, assetId, trackId, durationFrames)
    notices.push(`BGM 已排到人声轨下方（0~${durationFrames} 帧，role=follower：人声处自动闪避）`)
    return { done: true, patch: { bgmTrackId: trackId, bgmPlaced: true } }
  } catch (error) {
    notices.push(`BGM 排轨失败（需人工在编辑器放置）：${(error as Error).message}`)
    return { done: true, patch: { bgmPlaced: true } }
  }
}

export async function pollChatCutRender(state: ChatCutJobState): Promise<ChatCutRenderResult> {
  const notices = [...(state.notices ?? [])]

  if (state.phase === 'PREPARE') {
    // ── ① 等上传就绪：导出是**需要云端字节**的操作，素材没 ready 就导出等于白等
    const upload = await trackChatCutProgress(state.projectId, 'upload', state.uploadAssetIds)
    if (progressState(upload) !== 'ready') {
      // stageRatio 落在 [0, 0.5)：整个「上传就绪」占 PREPARE 前半段
      return { status: 'RUNNING', state: { ...state, notices, stageRatio: averageProgress(upload) * 0.5 } }
    }

    // ── ② 等转录就绪（字幕依赖它），预算有限，超时就放弃字幕直接出片
    //    ★ 整段用 `captionsDone` 守着：PREPARE 可能因为 ③ 的 BGM 等待而多轮进来，
    //      而这一段是**会写时间线**的动作（见 ChatCutJobState.captionsDone 的注释）。
    if (state.transcriptionAssetIds.length > 0 && !state.captionsDone) {
      const transcription = await trackChatCutProgress(state.projectId, 'transcription', state.transcriptionAssetIds)
      const progress = progressState(transcription)
      if (progress === 'waiting') {
        const waited = Date.now() - (state.prepareStartedAtMs ?? Date.now())
        if (waited < TRANSCRIPTION_WAIT_MS) {
          // 「等转录」整体占 PREPARE 的后半段（这里最容易一停就是几分钟，必须让进度动）
          return {
            status: 'RUNNING',
            state: { ...state, notices, stageRatio: 0.5 + averageProgress(transcription) * 0.4 },
          }
        }
        notices.push(`转录等待超过 ${Math.round(TRANSCRIPTION_WAIT_MS / 1000)}s 仍未就绪 ⇒ 本片不烧字幕直接出片`)
        state = { ...state, transcriptionAssetIds: [], notices }
      } else if (progress === 'failed') {
        notices.push('转录失败 ⇒ 本片不烧字幕直接出片')
        state = { ...state, transcriptionAssetIds: [], notices }
      }

      if (state.transcriptionAssetIds.length > 0) {
        // ── ① 先清理停顿（**必须排在开字幕之前**）
        //    ★ 实测（2026-09-21）：`clean_script` 会把 A1 上超过 250ms 的停顿压掉，
        //      也就是**改掉了配音轨的时间基**。而字幕是从转录派生的 —— 若先开字幕再压停顿，
        //      已生成的 Cue 时刻会整体错位，且 `enable` 的返回只会提示
        //      `captionReconciliation: { status: 'refresh-required' }`，**不会报错**。
        //      顺序反过来（先压停顿 → 再开字幕）就没有这个窗口。
        //    ⚠ 这一步没有 dry-run 参数，调用即写时间线，所以必须卡在「确认有转录」之后
        //      （无配音/无转录时它本就无事可做）。
        if (state.removeSilence) {
          try {
            await callTool('clean_script', {
              projectId: state.projectId,
              only: 'silence',
              silence: 'compress:250',
              track: 'A1',
            })
            notices.push('已清理停顿（超过 250ms 的静音压到 250ms）')
          } catch (error) {
            notices.push(`清理停顿失败：${(error as Error).message}`)
          }
        }

        // ── ② 开字幕：档位 → 内置预设 id（`CAPTION_PRESETS`，实测取的目录）
        //    ⚠ 只传 `preset`，**不能**同时传 `trackId` —— 文档明确说 enable 不接受 trackId。
        let captionsOn = false
        try {
          const preset = CAPTION_PRESETS[state.subtitleStyle ?? 'CLEAN']
          await enableChatCutCaptions(state.projectId, { preset })
          captionsOn = true
          notices.push(`字幕已开启（样式 ${state.subtitleStyle ?? 'CLEAN'} → 预设 ${preset}）`)
        } catch (error) {
          notices.push(`开字幕失败：${(error as Error).message}`)
        }

        // ── ③ 收窄来源到旁白轨 + 重建字幕程序（**开了字幕才做**，且与 ② 分开容错）
        //    分开的理由：这两步失败只说明「字幕可能读错来源 / 时刻可能偏」，
        //    字幕本身是开着的 —— 若和 ② 共用一个 catch，会把「已开」误报成「开字幕失败」。
        if (captionsOn) {
          try {
            // ★ enable 默认吃「所有可听见的轨道」，实测会把 V1（画面素材自带声）也列进来
            //   ⇒ 素材里的环境人声会混成字幕。能走到这里就说明**有配音**
            //   （只有配音轨才开转录，见 startTranscription 那行），所以直接限 A1。
            await setChatCutCaptionSources(state.projectId, ['A1'])
            // ★ 重建一次：上面压过停顿、刚改过来源，字幕程序要与当前时间线对齐。
            await refreshChatCutCaptions(state.projectId)
          } catch (error) {
            notices.push(`字幕来源/重建未完成（字幕可能读到素材原声）：${(error as Error).message}`)
          }
        }
      }
      state = { ...state, captionsDone: true, notices }
    }

    // ── ③ BGM：等生成就绪后建轨排轨（带预算的软等待，见 advanceChatCutBgm）
    const bgm = await advanceChatCutBgm(state, notices)
    state = { ...state, notices, ...(bgm.patch ?? {}) }
    if (!bgm.done) {
      // 还在生成：本轮先别导出（字幕/停顿已由 captionsDone 守住，不会重放）
      return { status: 'RUNNING', state: { ...state, stageRatio: 0.95 } }
    }

    const [renderId] = await submitChatCutExport(state.projectId, {
      format: 'video',
      codec: 'h264',
      resolution: '1080p',
      ...(state.timelineId ? { timelineId: state.timelineId } : {}),
    })
    return { status: 'RUNNING', state: { ...state, phase: 'RENDER', renderId, notices } }
  }

  if (!state.renderId) throw new Error('ChatCut 任务缺少 renderId（PREPARE 未成功提交导出）')
  const status = await trackChatCutExport(state.projectId, state.renderId)
  if (status.status === 'SUCCESS') {
    return { status: 'SUCCESS', state, resultUrl: status.downloadUrl, errorMessage: status.downloadUrl ? undefined : '导出完成但未返回下载地址' }
  }
  if (status.status === 'FAILED') {
    return { status: 'FAILED', state, errorMessage: status.errorMessage ?? 'ChatCut 导出失败' }
  }
  return { status: 'RUNNING', state: { ...state, notices } }
}
