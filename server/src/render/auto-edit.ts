import type { RenderClip } from '../services/render.service.js'

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
  // 中文口播通常 5-7 字/秒；保留少量头尾余量，避免字幕/配音从句中截断。
  const estimated = 700 + text.length * 165
  return Math.min(availableMs, Math.max(1_500, Math.min(7_000, estimated)))
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
      targetDurationMs: speechTargetMs(clip, available),
    }
  })

  // Talking-head 需要保持原始语义顺序；其余类型优先 Hook，再按质量分排序。
  if (profile === 'TALKING_HEAD') {
    candidates.sort((a, b) => a.sourceIndex - b.sourceIndex)
  } else {
    candidates.sort((a, b) => {
      const roleRank = (role: AutoEditRole) => (role === 'HOOK' ? 0 : role === 'TALKING' ? 1 : role === 'PROCESS' ? 2 : role === 'RESULT' ? 3 : role === 'VENUE' ? 4 : role === 'CTA' ? 5 : 6)
      return roleRank(a.role) - roleRank(b.role) || b.score - a.score || a.sourceIndex - b.sourceIndex
    })
  }

  const selected: AutoEditCandidate[] = []
  let total = 0
  for (const candidate of candidates) {
    if (candidate.targetDurationMs <= 0) continue
    const remaining = maxDurationMs - total
    if (remaining <= 0) break
    const target = Math.min(candidate.targetDurationMs, remaining)
    if (target < 800 && selected.length > 0) break
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
  return plan.candidates.map(({ clip, targetDurationMs }) => {
    const start = Math.max(0, clip.trimStartMs ?? 0)
    const available = effectiveDurationMs(clip)
    if (!available || targetDurationMs >= available) return clip
    return { ...clip, trimEndMs: start + Math.max(1, targetDurationMs) }
  })
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
