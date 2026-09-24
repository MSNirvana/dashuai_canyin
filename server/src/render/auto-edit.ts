import type { RenderClip } from '../services/render.service.js'
import type { ChatCutOptions } from './chatcut.js'
import { estimateSpeechMs } from './tts.js'

export const AUTO_EDIT_PROFILES = ['DISH', 'TALKING_HEAD', 'VENUE', 'MIXED'] as const
export type AutoEditProfile = (typeof AUTO_EDIT_PROFILES)[number]

export type AutoEditRole = 'HOOK' | 'TALKING' | 'PROCESS' | 'VENUE' | 'RESULT' | 'CTA' | 'OTHER'

export interface AutoEditCandidate {
  clip: RenderClip
  sourceIndex: number
  role: AutoEditRole
  score: number
  reason: string[]
  targetDurationMs: number
}

export interface AutoEditPlan {
  profile: AutoEditProfile
  confidence: number
  targetDurationMs: number
  candidates: AutoEditCandidate[]
  warnings: string[]
}

export interface OutputQualityInput {
  width: number | null
  height: number | null
  durationMs: number | null
  ok: boolean
  reason?: string
}

export interface OutputQuality {
  ok: boolean
  score: number
  warnings: string[]
}

const ROLE_WORDS: Record<AutoEditRole, RegExp> = {
  HOOK: /(开场|hook|成品|成菜|上桌|出锅|特写|招牌|卖点|试吃|口感|好吃)/i,
  TALKING: /(口播|讲解|老板|人物|采访|介绍|说话|台词)/i,
  PROCESS: /(制作|过程|烹饪|备料|切|炒|煎|炸|烤|蒸|调味|打包)/i,
  VENUE: /(门店|环境|装修|店内|店外|招牌|位置|座位|厨房|街景)/i,
  RESULT: /(成品|完成|出餐|端上|摆盘|装盘|试吃|结果)/i,
  CTA: /(地址|营业|电话|团购|到店|欢迎|关注|收藏|评论|下单)/i,
  OTHER: /$^/,
}

function textOf(clip: RenderClip): string {
  return [clip.shotType, clip.shotSize, clip.visualReq, clip.line].filter(Boolean).join(' ')
}

function roleOf(clip: RenderClip): AutoEditRole {
  const text = textOf(clip)
  for (const role of ['HOOK', 'TALKING', 'PROCESS', 'VENUE', 'RESULT', 'CTA'] as const) {
    if (ROLE_WORDS[role].test(text)) return role
  }
  return 'OTHER'
}

function effectiveDurationMs(clip: RenderClip): number {
  const start = Math.max(0, clip.trimStartMs ?? 0)
  if (clip.trimEndMs !== null && clip.trimEndMs > start) return clip.trimEndMs - start
  if (clip.durationMs !== null && clip.durationMs > start) return clip.durationMs - start
  return 0
}

function speechTargetMs(clip: RenderClip, availableMs: number): number {
  const text = (clip.line ?? '').trim()
  if (!text) return Math.min(availableMs, 4_500)
  // TTS 与规划必须使用同一套估算。镜头不够长时返回更长的目标，渲染器会用尾帧补齐，
  // 绝不能把可用时长当成硬上限，否则一句话会从中间被截断。
  const estimated = Math.min(12_000, Math.max(1_500, estimateSpeechMs(text) + 350))
  return availableMs > estimated ? estimated : Math.max(availableMs, estimated)
}

function roleBonus(profile: AutoEditProfile, role: AutoEditRole, index: number): number {
  if (profile === 'TALKING_HEAD') {
    return role === 'TALKING' ? 24 : role === 'HOOK' || role === 'RESULT' ? 8 : 0
  }
  if (profile === 'VENUE') {
    return role === 'VENUE' ? 24 : role === 'HOOK' || role === 'RESULT' ? 8 : 0
  }
  if (profile === 'DISH') {
    return role === 'HOOK' || role === 'RESULT' ? 26 : role === 'PROCESS' ? 18 : role === 'VENUE' ? 5 : 0
  }
  return index === 0 && role === 'HOOK' ? 20 : role === 'PROCESS' || role === 'RESULT' ? 12 : 0
}

export function inferAutoEditProfile(clips: RenderClip[]): { profile: AutoEditProfile; confidence: number } {
  if (clips.length === 0) return { profile: 'MIXED', confidence: 0 }
  const counts: Record<AutoEditProfile, number> = { DISH: 0, TALKING_HEAD: 0, VENUE: 0, MIXED: 0 }
  for (const clip of clips) {
    const role = roleOf(clip)
    const text = textOf(clip)
    if (role === 'TALKING' || (clip.line?.trim().length ?? 0) >= 24) counts.TALKING_HEAD += 2
    if (role === 'VENUE') counts.VENUE += 2
    if (role === 'HOOK' || role === 'RESULT' || role === 'PROCESS') counts.DISH += 1
    if (!text) counts.MIXED += 0.25
  }
  const ranked = (Object.entries(counts) as Array<[AutoEditProfile, number]>).sort((a, b) => b[1] - a[1])
  const [winner, score] = ranked[0] ?? ['MIXED', 0]
  const runnerUp = ranked[1]?.[1] ?? 0
  const confidence = score <= 0 ? 0.2 : Math.min(0.98, 0.45 + (score - runnerUp) / Math.max(1, clips.length * 2))
  return { profile: winner, confidence: Number(confidence.toFixed(3)) }
}

/**
 * Build a conservative, explainable plan. The planner never invents footage and never
 * extends a clip beyond its measured duration. AI can later replace the scores, while
 * this deterministic fallback remains valid when the gateway is unavailable.
 */
export function buildAutoEditPlan(
  clips: RenderClip[],
  requestedProfile?: AutoEditProfile,
  maxDurationMs = 60_000,
): AutoEditPlan {
  const inferred = inferAutoEditProfile(clips)
  const profile = requestedProfile ?? inferred.profile
  const warnings: string[] = []
  if (clips.length === 0) return { profile, confidence: 0, targetDurationMs: 0, candidates: [], warnings: ['没有可用素材'] }

  const byAsset = new Map<string, number>()
  const candidates = clips.map((clip, sourceIndex): AutoEditCandidate => {
    const role = roleOf(clip)
    const duration = effectiveDurationMs(clip)
    const reasons: string[] = []
    let score = 45
    if (duration >= 1_200 && duration <= 9_000) {
      score += 12
      reasons.push('时长适合短视频')
    } else if (duration > 0 && duration < 800) {
      score -= 18
      reasons.push('镜头过短')
    } else if (duration > 15_000) {
      score -= 8
      reasons.push('镜头较长，将截取高信息段')
    }
    if (clip.line?.trim()) {
      score += 8
      reasons.push('有对应口播文案')
    }
    if (clip.coverKey) {
      score += 3
      reasons.push('有封面/关键帧')
    }
    score += roleBonus(profile, role, sourceIndex)
    if (role !== 'OTHER') reasons.push(`识别为${role}`)
    const seen = byAsset.get(clip.assetId) ?? 0
    if (seen > 0) {
      score -= Math.min(18, seen * 6)
      reasons.push('素材重复使用，降低优先级')
    }
    byAsset.set(clip.assetId, seen + 1)
    const available = Math.max(1, duration)
    return {
      clip,
      sourceIndex,
      role,
      score: Math.max(0, Math.min(100, score)),
      reason: reasons,
      // 默认模式必须把完整原片作为成本/时长单位；不能用台词估时把一段长素材
      // 当成短镜头选入，随后又在渲染阶段为了卡总时长把它从中间截断。
      targetDurationMs: available,
    }
  })

  // 默认模式必须尊重用户上传顺序。角色识别只用于评分、淘汰和解释，不能把「成品」
  // 强行挪到片头导致叙事倒置；只有未来显式的高级重排策略才允许改变 sourceIndex。
  candidates.sort((a, b) => a.sourceIndex - b.sourceIndex)

  const selected: AutoEditCandidate[] = []
  let total = 0
  for (const candidate of candidates) {
    if (candidate.targetDurationMs <= 0) continue
    const remaining = maxDurationMs - total
    if (remaining <= 0) break
    // 最后一条台词也不能为了卡上限而被截断；宁可停止继续选镜头，保住已经完整的语句。
    if (selected.length > 0 && candidate.targetDurationMs > remaining) break
    const target = candidate.targetDurationMs
    selected.push({ ...candidate, targetDurationMs: target })
    total += target
  }
  if (selected.length === 0) {
    warnings.push('素材没有可识别时长，保留原始顺序交给渲染器处理')
    return { profile, confidence: inferred.confidence, targetDurationMs: 0, candidates: clips.map((clip, sourceIndex) => ({ clip, sourceIndex, role: 'OTHER', score: 1, reason: ['规则降级'], targetDurationMs: effectiveDurationMs(clip) })), warnings }
  }
  if (total < 12_000) warnings.push('可用素材较短，成片将按实际素材时长输出')
  return { profile, confidence: requestedProfile ? 1 : inferred.confidence, targetDurationMs: total, candidates: selected, warnings }
}

export function applyAutoEditPlan(plan: AutoEditPlan): RenderClip[] {
  // 默认模式没有逐字 ASR 终点之前，不能根据「文案估算时长」裁原视频。
  // 同一句话的真实语速可能比估算慢很多，按估算 trim 会直接切掉句尾。
  // 规划器仍负责筛选素材；真正的裁切只交给 worker 的黑屏/坏帧等确定性信号。
  return plan.candidates.map(({ clip }) => clip)
}

/**
 * AUTO 模式的唯一决策入口。前端只表达“交给 AI”，具体参数在服务端按素材画像确定，
 * 这样默认模式不会被面板上的历史默认值悄悄覆盖。
 */
export function resolveAutoChatcutOptions(
  options: ChatCutOptions,
  profile: AutoEditProfile,
  clips: RenderClip[],
): ChatCutOptions {
  return {
    ...options,
    editMode: 'ADVANCED',
    voiceId: 'none',
    subtitles: true,
    subtitleMode: 'SOURCE_AUDIO',
    subtitleStyle: 'CLEAN',
    // 默认模式以完整表达优先：不按比例压缩镜头，也不让交叉转场吞掉句尾。
    pacing: 'NATURAL',
    transitions: 'CLEAN',
    // 不能只压缩音轨静音，否则画面、原声与字幕会失去同一时间轴。
    // 默认模式仅裁首尾确定性坏画面，中间停顿保留到后续音画联合裁剪能力处理。
    removeSilence: false,
    normalizeAudio: true,
    // 菜品制作使用更明快的节奏，空间展示偏质感，其余保持轻柔；worker 负责曲库/兜底和混音。
    bgm: profile === 'DISH' ? 'UPBEAT' : profile === 'VENUE' ? 'PREMIUM' : 'LIGHT',
    note: options.note,
  }
}

export function validateOutputQuality(meta: OutputQualityInput, options?: { maxDurationMs?: number }): OutputQuality {
  const warnings: string[] = []
  if (!meta.ok) warnings.push(meta.reason || '输出文件无法解析')
  if (!meta.width || !meta.height) warnings.push('输出缺少有效画面尺寸')
  else {
    const ratio = meta.width / meta.height
    if (Math.abs(ratio - 9 / 16) > 0.03) warnings.push('输出不是 9:16 竖屏比例')
  }
  if (!meta.durationMs || meta.durationMs < 800) warnings.push('输出时长过短')
  const maxDurationMs = options?.maxDurationMs ?? 65_000
  if (meta.durationMs && meta.durationMs > maxDurationMs) warnings.push(`输出超过 ${Math.round(maxDurationMs / 1000)} 秒限制`)
  return { ok: warnings.length === 0, score: Math.max(0, 100 - warnings.length * 30), warnings }
}
