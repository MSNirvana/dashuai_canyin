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
 *   我们的素材在进这条管道前已经过 `ffmpegNormalize` 归一化成 9:16，
 *   所以只做「声明正确的元数据」，不需要那套预处理。
 */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { callTool, type ChatCutJobInput } from './chatcut.js'
import { prisma } from '../db.js'
import { activeTtsProvider } from '../services/tts-provider.service.js'
import { synthesizeNarration } from './tts.js'

/** 一个上传会话最多导 4 个素材（官方助手的硬限制），超了要重开会话 */
const SESSION_BATCH_SIZE = 4
const MULTIPART_SIGN_BATCH_SIZE = 100
const IMPORT_ATTEMPT_TIMEOUT_MS = Number(process.env.CHATCUT_IMPORT_TIMEOUT_MS ?? 120_000)

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

async function postImport(
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
}

async function putRange(
  url: string,
  open: ChatCutUploadSource['open'],
  start: number,
  endInclusive: number,
): Promise<string> {
  const length = endInclusive - start + 1
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
export async function importAssets(
  projectId: string,
  sources: ChatCutUploadSource[],
): Promise<Array<{ assetId: string; filename: string }>> {
  const results: Array<{ assetId: string; filename: string }> = []
  for (let start = 0; start < sources.length; start += SESSION_BATCH_SIZE) {
    const batch = sources.slice(start, start + SESSION_BATCH_SIZE)
    const session = await createImportSession(projectId)
    for (const source of batch) {
      results.push({ assetId: await importAsset(session, source), filename: source.filename })
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
 * `preset` 省略即默认 Plain 样式，与 `preset:"auto"` 等价。
 */
export async function enableChatCutCaptions(
  projectId: string,
  options: { preset?: string; trackId?: string } = {},
): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = { projectId, action: 'enable' }
  if (options.preset) args.preset = options.preset
  if (options.trackId) args.trackId = options.trackId
  return callTool('edit_captions', args)
}

/** 一次立即的状态读取（不是「阻塞等待到出片」）—— 非终态要隔 ≥10s 再查 */
export async function trackChatCutProgress(
  projectId: string,
  target: 'upload' | 'transcription',
  assetIds?: string[],
): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = { projectId, target }
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
const VOICE_ENV_KEYS: Record<string, string> = {
  'warm-female': 'CHATCUT_TTS_VOICE_WARM_FEMALE',
  'bright-female': 'CHATCUT_TTS_VOICE_BRIGHT_FEMALE',
  'gentle-male': 'CHATCUT_TTS_VOICE_GENTLE_MALE',
  'magnetic-male': 'CHATCUT_TTS_VOICE_MAGNETIC_MALE',
  'energetic-youth': 'CHATCUT_TTS_VOICE_ENERGETIC_YOUTH',
}

/** 从 COS 签名 URL 拉素材：先 HEAD 拿字节数（finalize 会核对），再给流 */
async function remoteSource(
  url: string,
  filename: string,
  contentType: string,
  durationMs: number | null,
): Promise<ChatCutUploadSource> {
  const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(30_000) })
  if (!head.ok) throw new Error(`取素材大小失败（HTTP ${head.status}）：${filename}`)
  const size = Number(head.headers.get('content-length') ?? 0)
  if (!Number.isFinite(size) || size <= 0) throw new Error(`素材 ${filename} 的 content-length 非法：${size}`)
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
      ...(durationMs ? { durationInSeconds: durationMs / 1000 } : {}),
      // ⚠ 不声明 width/height：原始素材尺寸未知，声明错的比不声明更糟。
      //   画布适配交给 edit_item 的 fit:"cover"（按画布裁切填满），不依赖这里的声明。
      hasAudioTrack: true,
    },
  }
}

function framesOf(ms: number, fps: number): number {
  return Math.max(1, Math.round((ms / 1000) * fps))
}

export async function startChatCutRender(input: ChatCutJobInput): Promise<ChatCutRenderResult> {
  const clips = input.clips.filter((clip) => clip.sourceUrl)
  if (clips.length === 0) throw new Error('AI 档没有可用分镜素材')
  const notices: string[] = []

  const project = await createChatCutProject({
    name: input.title || `大帅餐饮成片-${input.taskId}`,
    width: input.output.width,
    height: input.output.height,
    fps: input.output.fps,
    description: input.options.note || undefined,
  })
  const projectId = project.projectId
  const videoTrackId = project.trackIds[0]

  // ── 1) 分镜素材：直接推 COS 原始字节（不本地转码，画布适配交给 fit:"cover"）
  const clipSources = await Promise.all(
    clips.map((clip, index) => remoteSource(clip.sourceUrl, `shot-${index + 1}.mp4`, 'video/mp4', clip.durationMs)),
  )

  // ── 2) 配音：逐镜头合成，时长对齐该镜头（与本地管线的语义一致）
  const dir = await mkdtemp(join(tmpdir(), 'dashuai-chatcut-'))
  const voiceSources: ChatCutUploadSource[] = []
  const voiceSpans: Array<{ index: number; fromFrame: number; durationInFrames: number }> = []
  let cursorFrame = 0
  const fps = input.output.fps
  try {
    const provider = await activeTtsProvider(prisma).catch(() => null)
    const speaker = VOICE_ENV_KEYS[input.options.voiceId]
      ? process.env[VOICE_ENV_KEYS[input.options.voiceId]!]?.trim()
      : undefined
    const voiceOverride = speaker && provider ? { ...provider, voiceId: speaker } : provider
    if (!provider) notices.push('未配置 TTS 供应商 ⇒ 只出画面与字幕，没有配音')
    else if (speaker && !provider.apiKey) notices.push('TTS 供应商缺 apiKey ⇒ 配音为静音轨')

    for (let index = 0; index < clips.length; index += 1) {
      const clip = clips[index]!
      const durationMs = clip.durationMs ?? clip.trimEndMs ?? 0
      if (!clip.line?.trim() || durationMs <= 0) {
        cursorFrame += framesOf(durationMs, fps)
        continue
      }
      const outPath = join(dir, `voice-${index + 1}.m4a`)
      await synthesizeNarration(clip.line, durationMs, outPath, voiceOverride, 90_000)
      const size = statSync(outPath).size
      voiceSources.push({
        filename: `voice-${index + 1}.m4a`,
        contentType: 'audio/mp4',
        assetType: 'audio',
        size,
        open: () => createReadStream(outPath),
        meta: { durationInSeconds: durationMs / 1000 },
        // ★ 只有配音轨要 ASR：字幕就是从它的转录派生的（分镜素材开转录纯属烧额度）
        startTranscription: input.options.subtitles,
      })
      voiceSpans.push({ index, fromFrame: cursorFrame, durationInFrames: framesOf(durationMs, fps) })
      cursorFrame += framesOf(durationMs, fps)
    }
  } finally {
    // 字节已经被推上去了（流式读完），文件可以删
    await rm(dir, { recursive: true, force: true })
  }

  // ── 3) 一次导入全部素材（每 4 个开一个上传会话，importAssets 内部处理）
  const imported = await importAssets(projectId, [...clipSources, ...voiceSources])
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
    const trimEndMs = clip.trimEndMs && clip.trimEndMs > trimStartMs ? clip.trimEndMs : null
    const durationFrames = clip.durationMs
      ? framesOf(clip.durationMs, fps)
      : trimEndMs
        ? framesOf(trimEndMs - trimStartMs, fps)
        : undefined
    adds.push({
      type: 'video',
      assetId,
      fromFrame: timelineFrame,
      ...(durationFrames ? { durationInFrames: durationFrames } : {}),
      ...(trimStartMs > 0 ? { sourceStartFromInSeconds: trimStartMs / 1000 } : {}),
      // 画布是 9:16，原始素材比例未知 ⇒ cover 裁切填满，不出现黑边
      fit: 'cover',
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

  // ── 5) 人声轨设为 anchor（引擎据此让 follower 轨自动闪避；不设则谁都不让位）
  const audioTrackId = [...JSON.stringify(added).matchAll(/"trackId":"([0-9a-f]{8,})"/g)]
    .map((match) => match[1]!)
    .find((id) => id !== videoTrackId)
  if (audioTrackId && voiceSpans.length > 0) {
    await setChatCutTrackRole(projectId, audioTrackId, 'anchor').catch((error) => {
      notices.push(`人声轨 anchor 设置失败（自动闪避不生效）：${(error as Error).message}`)
    })
  }

  // ── 6) BGM（默认关闭：生成类工具会花 ChatCut 额度，商务口径未核实前不默认开）
  if (input.options.bgm !== 'NONE' && process.env.CHATCUT_BGM_ENABLED === 'true') {
    try {
      const prompt = BGM_PROMPTS[input.options.bgm] ?? BGM_PROMPTS.LIGHT!
      const job = await callTool('submit_music', { generationType: 'instrumental', prompt, name: 'dashuai-bgm' })
      notices.push(`BGM 已提交生成（jobId=${job.jobId ?? job.id ?? '?'}）；本版未自动排轨，需人工在编辑器放置`)
    } catch (error) {
      notices.push(`BGM 生成提交失败：${(error as Error).message}`)
    }
  } else if (input.options.bgm !== 'NONE') {
    notices.push(`已选 BGM=${input.options.bgm}，但 CHATCUT_BGM_ENABLED 未开 ⇒ 本次无背景音乐`)
  }

  const state: ChatCutJobState = {
    projectId,
    timelineId: project.timelineId,
    editorUrl: project.editorUrl,
    uploadAssetIds: imported.map((item) => item.assetId),
    transcriptionAssetIds: voiceSources.filter((source) => source.startTranscription).map((source) => assetIdOf(source.filename)),
    phase: 'PREPARE',
    prepareStartedAtMs: Date.now(),
    notices,
  }
  return { status: 'RUNNING', state }
}

const BGM_PROMPTS: Record<string, string> = {
  LIGHT: 'warm minimal acoustic guitar and soft piano, calm, under a restaurant promo voiceover, not distracting, no vocals',
  UPBEAT: 'upbeat light electronic pop, confident energy, background bed under a short food promo, no vocals',
  PREMIUM: 'cinematic warm strings and soft piano, elegant premium mood for a food brand film, no vocals',
}

/**
 * 就绪判定。实测返回形如
 *   { entries:[{id,name,status:"ready"|"pending"|…,ok,terminal,error,progress}], success, terminal }
 * 三态：全就绪 / 有终态失败 / 还需等。
 * ★ 宁可「还需等」也不要误判就绪 —— 前置没就绪就提交导出，会得到一个慢慢跑或者直接失败的渲染。
 */
function progressState(value: Record<string, unknown>): 'ready' | 'failed' | 'waiting' {
  const entries = resultEntries(value)
  if (entries.length === 0) return 'waiting'
  const failed = entries.some((entry) => {
    const status = (pickString(entry, 'status') ?? '').toLowerCase()
    return entry.ok === false || Boolean(entry.error) || ['failed', 'error', 'cancelled', 'canceled'].includes(status)
  })
  if (failed) return 'failed'
  const ready = entries.every((entry) => {
    const status = (pickString(entry, 'status') ?? '').toLowerCase()
    return entry.ok === true || ['ready', 'completed', 'complete', 'done', 'success', 'succeeded'].includes(status)
  })
  return ready ? 'ready' : 'waiting'
}

export async function pollChatCutRender(state: ChatCutJobState): Promise<ChatCutRenderResult> {
  const notices = [...(state.notices ?? [])]

  if (state.phase === 'PREPARE') {
    // ── ① 等上传就绪：导出是**需要云端字节**的操作，素材没 ready 就导出等于白等
    const upload = await trackChatCutProgress(state.projectId, 'upload', state.uploadAssetIds)
    if (progressState(upload) !== 'ready') {
      return { status: 'RUNNING', state: { ...state, notices } }
    }

    // ── ② 等转录就绪（字幕依赖它），预算有限，超时就放弃字幕直接出片
    if (state.transcriptionAssetIds.length > 0) {
      const transcription = await trackChatCutProgress(state.projectId, 'transcription', state.transcriptionAssetIds)
      const progress = progressState(transcription)
      if (progress === 'waiting') {
        const waited = Date.now() - (state.prepareStartedAtMs ?? Date.now())
        if (waited < TRANSCRIPTION_WAIT_MS) {
          return { status: 'RUNNING', state: { ...state, notices } }
        }
        notices.push(`转录等待超过 ${Math.round(TRANSCRIPTION_WAIT_MS / 1000)}s 仍未就绪 ⇒ 本片不烧字幕直接出片`)
        state = { ...state, transcriptionAssetIds: [], notices }
      } else if (progress === 'failed') {
        notices.push('转录失败 ⇒ 本片不烧字幕直接出片')
        state = { ...state, transcriptionAssetIds: [], notices }
      }
      if (state.transcriptionAssetIds.length > 0) {
        try {
          await enableChatCutCaptions(state.projectId)
        } catch (error) {
          notices.push(`开字幕失败：${(error as Error).message}`)
        }
      }
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
