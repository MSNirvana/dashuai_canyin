import { useEffect, useRef, useState, useCallback } from 'react'
import { View, Text, Button, Slider, Video, Image, Switch, Textarea } from '@tarojs/components'
import Taro, { useDidShow, useDidHide } from '@tarojs/taro'
import { getCreation, type CreationDetail } from '../../services/creation'
import {
  getPublishMaterial, generatePublishMaterial,
  type PublishMaterial, type PublishMaterialEstimate,
} from '../../services/publish-material'
import {
  submitRender, listRenders, getRender, getPlayUrl, getResultPlayUrl, getGradeCapabilities, previewColor,
  type RenderTask, type RenderGrade, type ColorGrade, type ChatCutOptions,
  isVoiceOff, type AutoEditProfile, type SubtitleMode, CHATCUT_VOICES,
} from '../../services/render'
import { uploadAudioFile } from '../../services/upload'
import { useMerchantStore } from '../../store/merchant'
import { readRouteId, isNumericId } from '../../utils/route-id'
// 时间一律走这里：接口给的是 UTC 的 ISO 串（…T…Z），直接渲染/截串都会露 T、Z 且差 8 小时
import { formatMinute } from '../../utils/time'
import ProgressLine from '../../components/progress-line'
import SectionHelp from '../../components/section-help'
import './compose.scss'

const DEFAULT_COLOR: ColorGrade = { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 }
/**
 * 每次生成类调用都新建一个 requestId（与 creation/edit.tsx 同款）。
 * ★ 不要"省事"复用一个模块级常量：服务端按 requestId 做幂等 ——
 *   复用同一个 id 会让第二次点击被当成**重放**，直接返回上次结果且不再扣费，
 *   表现就是「改了参数再点生成，什么都没变」。
 */
function newRequestId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}
const GRADE_RATIO: Record<RenderGrade, number> = { BASIC: 1, AI: 1.5, PREMIUM: 3 }
/**
 * 顶部播放器的 video id：成片记录里点「播放」后要用 `VideoContext.play()` 兜一手
 * （`autoplay` 属性在动态换源时不一定肯自己播），必须与下面 `<Video id>` 一致。
 */
const PLAYER_VIDEO_ID = 'rcompose-player'
/**
 * AI 档的 6 项选项（2026-09-21 已全部接到真实原语，面板放回）。
 *
 * ★ 面板文案与**服务端能力**的对应关系（改文案前先看这里，别让两边说法不一致）：
 *   · 字幕样式  → `edit_captions enable preset`（ChatCut 内置预设，见服务端 CAPTION_PRESETS）
 *   · 剪辑节奏  → 镜头时长系数 + 转场帧数（FAST 还会给配音让路，见下面的 PACING_HINT）
 *   · 转场风格  → `edit_item adds:[{type:'transition'}]`（内置转场，见服务端 TRANSITION_PLANS；
 *                 转场要占用两侧素材，所以会改整片时长 —— 「硬切」档不占用任何素材）
 *   · 清理停顿  → `clean_script`（只处理**已转录**内容 ⇒ 依赖配音）
 *   · 统一音量  → 本地测每段响度 + `edit_item decibelAdjustment`（ChatCut 没有响度归一项）
 *   · 配乐      → `submit_music` + 自动排轨（**生成类**调用，受 CHATCUT_BGM_ENABLED 控制）
 * ⚠ 依赖配音的两项（字幕样式、清理停顿）只在「有配音」时才显示 —— 没有配音轨就没有转录，
 *   服务端不会执行它们。显示了却一定不生效，比不显示更伤信任。
 */
const DEFAULT_CHATCUT: ChatCutOptions = {
  editMode: 'AUTO',
  voiceId: 'none', subtitles: true, subtitleMode: 'SOURCE_AUDIO', subtitleStyle: 'CLEAN', bgm: 'NONE',
  // ★ 默认有转场（2026-09-22 由 'CLEAN' 改来）：`CLEAN` 就是「不加转场」，而用户从不主动改
  //   这个选项 ⇒ 每条默认出片都必然是硬拼，线上真实投诉正是「没有转场和剪辑」。
  //   代价（整片略短）不在这里解释 —— `TRANSITION_HINT.SMOOTH` 已经把话说给用户了。
  pacing: 'NATURAL', transitions: 'SMOOTH', removeSilence: true, normalizeAudio: true,
  // ★★ 默认 = **原路线**（原文直传）：**不改变原来 AI 生成的行为**，用户主动选才走本地打底。
  clipPrep: 'ORIGINAL', note: '',
}

/** 字幕样式标签，保持服务端枚举与界面文案一一对应。 */
const SUBTITLE_STYLE_LABEL: Record<ChatCutOptions['subtitleStyle'], string> = {
  CLEAN: '简洁', EMPHASIS: '重点强调', SOCIAL: '社交风格',
}
const SUBTITLE_MODE_LABEL: Record<SubtitleMode, string> = {
  OFF: '关闭字幕', VOICE: '旁白字幕', SOURCE_AUDIO: '原声识别', VOICE_AND_SOURCE: '旁白+原声',
}
/**
 * 成片记录里给「本地打底」加的后缀。
 * ★ 只在走过该路线时才加：默认路线不加任何字样，**不改变原有记录的观感**。
 */
const clipPrepSuffix = (task: { chatcut?: Partial<ChatCutOptions> } | null | undefined): string =>
  task?.chatcut?.clipPrep === 'NORMALIZED' ? ' · 本地打底' : ''
const GRADE_OPTIONS = [
  { key: 'BASIC' as const, title: '基础生成', desc: '粗剪拼接 + 调色' },
  { key: 'AI' as const, title: 'AI 生成', desc: '自动识别 + 智能剪辑' },
  { key: 'PREMIUM' as const, title: '精品生成', desc: '剪辑师人工精剪' },
]
const AUTO_EDIT_PROFILE_OPTIONS: Array<{ value: AutoEditProfile | undefined; label: string }> = [
  { value: undefined, label: '自动识别' },
  { value: 'DISH', label: '菜品展示' },
  { value: 'TALKING_HEAD', label: '口播人设' },
  { value: 'VENUE', label: '门店环境' },
  { value: 'MIXED', label: '综合探店' },
]
const ACTIVE_STATUS = ['QUEUED', 'RUNNING', 'MANUAL_PENDING', 'MANUAL_DOING']
const STATUS_LABEL: Record<string, string> = {
  QUEUED: '排队中', RUNNING: '合成中', MANUAL_PENDING: '等待接单', MANUAL_DOING: '人工剪辑中',
  SUCCESS: '已完成', FAILED: '失败', TIMEOUT: '超时', CANCELLED: '已取消',
  REFUND_PENDING: '退款确认中', SETTLEMENT_PENDING: '退款确认中',
}

/**
 * 档位的中文名。三档可以**同时**各有任务在跑（见下面的 activeTasks），所以凡是「说到某一个任务」
 * 的地方都必须带上档位名 —— 否则「任务处理中」这句话在一个页面上出现两次就没法区分了。
 */
const gradeTitle = (value: RenderGrade | string | null | undefined) =>
  GRADE_OPTIONS.find((option) => option.key === value)?.title || '合成'

/** 调色四轴：数组顺序即界面顺序。标签只用于展示，服务端只认 key */
const COLOR_AXES: [keyof ColorGrade, string][] = [
  ['brightness', '亮度'],
  ['contrast', '对比度'],
  ['saturation', '饱和度'],
  ['sharpen', '锐化'],
]

/** 松手后等这么久再请求精确预览：连续微调只发最后一次，不把服务端打满 */
const COLOR_PREVIEW_DEBOUNCE_MS = 800

const isNoopColor = (c: ColorGrade) => !c.brightness && !c.contrast && !c.saturation && !c.sharpen
const colorSignature = (c: ColorGrade) => `${c.brightness}/${c.contrast}/${c.saturation}/${c.sharpen}`

/**
 * 两组调色参数是否一致。
 * 成片任务自带 `color`（服务端原样回传提交时的四轴），所以「画面上的调色有没有正式成片」
 * 可以直接比对数值，不需要另存一份标志位。
 */
const sameColor = (a: ColorGrade | null | undefined, b: ColorGrade) => !!a && colorSignature(a) === colorSignature(b)

function isColorGrade(value: unknown): value is ColorGrade {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return COLOR_AXES.every(([axis]) => Number.isFinite(record[axis]))
}

/**
 * 离开页面时的界面快照。
 *
 * 为什么需要它：小程序切到后台再回来有两种命运 ——
 *   · 五秒内回来是热启动，React state 还在，本文件这段逻辑完全不参与；
 *   · 被系统回收后再打开是**冷启动恢复**，页面组件会被重建、state 全丢，
 *     连 Taro 的 current.router 都可能还没挂上（渲染期读到空编号 ⇒ 用户看到「编号丢失」）。
 * 所以编号与三项关键选择（档位、调色、正在看的那条成片）必须落一份到 storage。
 *
 * ★ 只存**能重建的**：绝不存任何播放地址 —— 它们是签名 URL、会过期，存下来回来必然播不了。
 *   成片一律记 resultId，回来后在重新拉到的任务列表里按 id 找。
 */
const COMPOSE_SNAPSHOT_KEY = 'dashuai.compose.snapshot'
/** 快照有效期。过期的快照当没存过：隔天再进来该是一条干净的页面，而不是昨天拖到一半的滑块 */
const COMPOSE_SNAPSHOT_TTL_MS = 12 * 60 * 60 * 1000

interface ComposeSnapshot {
  id: string
  grade: RenderGrade
  color: ColorGrade
  resultId: string | null
  updatedAt: number
}

function readComposeSnapshot(): ComposeSnapshot | null {
  try {
    const raw = Taro.getStorageSync(COMPOSE_SNAPSHOT_KEY) as ComposeSnapshot | '' | null
    if (!raw || typeof raw !== 'object') return null
    const snap = raw as ComposeSnapshot
    if (!isNumericId(snap.id)) return null
    if (!GRADE_OPTIONS.some((option) => option.key === snap.grade)) return null
    if (!isColorGrade(snap.color)) return null
    if (!Number.isFinite(snap.updatedAt) || Date.now() - snap.updatedAt > COMPOSE_SNAPSHOT_TTL_MS) return null
    return snap
  } catch {
    return null
  }
}

function writeComposeSnapshot(snap: ComposeSnapshot): void {
  // 存不下（超限/隐私模式）纯属体验增强失效，不该把用户的正常操作打断
  try { Taro.setStorageSync(COMPOSE_SNAPSHOT_KEY, snap) } catch { /* ignore */ }
}

/**
 * 拖动滑块时的**近似**滤镜：只为「松手前先看到变化趋势」，精确结果一律以服务端预览为准。
 * 与服务端 buildColorFilter（ffmpeg 的 eq / unsharp）的对应关系逐个说清：
 *
 *   · contrast / saturation —— 语义与 CSS contrast()/saturate() **一致**，公式也一致
 *     （都是 1 + v/100），所以直接照搬。Slider 区间本就是 [-100,100]，
 *     1+v/100 天然落在 ffmpeg 的 clamp 窗口（0..2 / 0..3）内，不需要再钳一次。
 *   · brightness —— **只能近似，别当成准的**：ffmpeg eq 的 brightness 是**加法**偏移
 *     （在 YUV 上加常数），而 CSS brightness() 是**乘法**缩放，加法没有等价的 CSS 写法。
 *     这里用乘法做方向性近似，并刻意把系数压到 0.5：宁可欠一点，也不要过冲 ——
 *     过冲会让用户朝反方向调回来，比「变化不明显」更糟。
 *   · sharpen —— **故意不实现**：CSS 没有任何锐化滤镜。若拿 contrast 之类顶替，
 *     「拖动锐化看不出变化」这个真实信息就被掩盖了，用户只会一路往上推 —— 那才是骗人。
 *     锐化以松手后的服务端预览为准。
 */
function cssApproxFilter(c: ColorGrade): string {
  const parts = [`contrast(${(1 + c.contrast / 100).toFixed(3)})`, `saturate(${(1 + c.saturation / 100).toFixed(3)})`]
  // -100 时系数为 0.5（而不是 0，那会整幅变黑）；亮度放最前更符合阅读直觉
  if (c.brightness) parts.unshift(`brightness(${Math.max(0, 1 + (c.brightness / 100) * 0.5).toFixed(3)})`)
  return parts.join(' ')
}

// 仅作默认配置参考，不替代服务端实际结算。
function estimatePoints(shots: CreationDetail['shots'], grade: RenderGrade, recolor = false) {
  const seconds = shots.reduce((sum, shot) => {
    if (!shot.assetId) return sum
    const end = shot.trimEndMs ?? shot.assetDurationMs
    return sum + (end && end > shot.trimStartMs ? (end - shot.trimStartMs) / 1000 : shot.durationSuggest || 0)
  }, 0)
  return Math.max(1, Math.ceil(seconds * GRADE_RATIO[grade] * (recolor ? 0.5 : 1)))
}

export default function RenderCompose() {
  // ★ 编号当场校验，绝不把「拿到的原值」直接用去发请求。
  //   最典型的坑是字符串 'undefined'：`?id=${undefined}` 会让 URL 看着完全正常，
  //   但服务端 idParam 对非纯数字串一律回 `{"code":4000,"message":"参数不合法"}` ——
  //   用户看到的是一句指向不了任何操作的报错（详见 utils/route-id.ts）。
  // ★ 但「当场校验」不等于「只在这里读一次就定终身」：冷启动恢复时路由参数可能还没就绪，
  //   所以页面每次显示都会再确认一遍（见 useDidShow），而不是把空值当成结论。
  const routeParams = () => Taro.getCurrentInstance().router?.params as Record<string, unknown> | undefined
  const [boot] = useState(() => {
    const routeId = readRouteId(routeParams())
    const snap = readComposeSnapshot()
    // 快照只在「编号对得上」时认领：从列表点进另一条创作时，
    // 绝不能把上一条的档位、调色、选中成片张冠李戴过来
    return { id: routeId, snap: snap && (!routeId || snap.id === routeId) ? snap : null }
  })
  const { available, isMember, refreshMe } = useMerchantStore()
  const [id, setId] = useState<string | null>(boot.id)
  const idRef = useRef<string | null>(boot.id)
  const snapshotRef = useRef<ComposeSnapshot | null>(null)
  /** 离开时正在看的那条成片；重新拉到任务列表后优先把它选回来 */
  const resultPrefRef = useRef<string | null>(boot.snap?.resultId ?? null)
  const [detail, setDetail] = useState<CreationDetail | null>(null)
  const [color, setColor] = useState<ColorGrade>(boot.snap?.color ?? DEFAULT_COLOR)
  const [grade, setGrade] = useState<RenderGrade>(boot.snap?.grade ?? 'BASIC')
  const [chatcut, setChatcut] = useState<ChatCutOptions>(DEFAULT_CHATCUT)
  const [autoEditProfile, setAutoEditProfile] = useState<AutoEditProfile | undefined>(undefined)
  const [customVoice, setCustomVoice] = useState<{ cosKey: string; durationMs?: number; name: string } | null>(null)
  const [customVoiceUploading, setCustomVoiceUploading] = useState(false)
  const [recording, setRecording] = useState(false)
  /** 是否「不配音」（原声直出）。本地 TTS 音色由服务器后台配置。 */
  const voiceOff = isVoiceOff(chatcut.voiceId)
  const [renders, setRenders] = useState<RenderTask[]>([])
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [selectedResult, setSelectedResult] = useState<RenderTask | null>(null)
  /**
   * 分镜素材区是否展开。
   *
   * ★ 默认**收起**（需求原话：「分镜素材默认做一个收缩，用户可以点击打开」）。
   *   理由不只是"少占屏"：这块是「挑素材、检查画面」用的，而进这个页面的主目的是出片 ——
   *   一屏 2 列的全部分镜会把播放窗和生成按钮全顶到屏幕外，反而让主路径更难走。
   * ★ 不持久化到 storage：这里存的是「临时看一眼」的状态，写盘后一旦因为别的原因
   *   残留成「展开」，用户下次进来又变成满屏素材 —— 而这类"记忆"没人会去关。
   */
  const [clipsOpen, setClipsOpen] = useState(false)
  /**
   * 就地放大播放的那一条分镜素材。
   *
   * ★ 为什么是浮层而不是「把下方播放窗换掉 + 滚过去」（改之前的行为）：
   *   用户在素材列表中部点一下，页面会整页跳走 —— 看起来像点了别的东西，
   *   而且下方播放窗里原本正在看的**成片/调色预览被顶掉了**，看完还得再切回来。
   *   浮层没有滚动、没有副作用，关掉就回到原来的位置与原来的播放内容。
   */
  const [shotPreview, setShotPreview] = useState<{
    assetId: string
    seq: number
    shotType: string
    url: string | null
    error: string
  } | null>(null)
  /**
   * 发布素材（标题 / 封面 / 文案）。挂在**创作**上，每个创作一份 ——
   * 所以它是「这条创作的发布包装」，与具体某个档位的成片无关。
   */
  const [publishMat, setPublishMat] = useState<PublishMaterial | null>(null)
  const [publishEstimate, setPublishEstimate] = useState<PublishMaterialEstimate | null>(null)
  const [publishLoading, setPublishLoading] = useState(false)
  const [publishError, setPublishError] = useState('')
  /** 服务端给的一句补充说明（封面失败 / 文本降级 / 重复提交），与 publishError 分开：它是提示不是错误 */
  const [publishNotice, setPublishNotice] = useState('')
  /** 生成已过去的毫秒数（只用于把"在动"显示出来，见下面 ProgressLine 的说明） */
  const [pubElapsed, setPubElapsed] = useState(0)
  const [submittingGrades, setSubmittingGrades] = useState<RenderGrade[]>([])
  const submitting = submittingGrades.includes(grade)
  const [saving, setSaving] = useState(false)
  const [visible, setVisible] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [resultError, setResultError] = useState('')
  const [pollError, setPollError] = useState('')
  /**
   * 任务**收敛失败**的通知（每条带档位）。
   *
   * ★ 为什么不复用 pollError：两者生命周期不同 ——
   *   · pollError 是「查询/等待类」问题（网络抖动、30 分钟上限），一次成功查询就该清掉；
   *   · 任务失败的通知**不能**被别的档位的成功查询顺手擦掉。
   *   三档并行时共用一格就是：「A 档失败了、B 档还在跑」→ B 的下一次成功轮询把
   *   A 的失败提示清成空串，用户永远看不到 A 为什么失败。
   *   清空时机只有两个：用户重新提交、或点「重新查询」。
   */
  const [taskNotices, setTaskNotices] = useState<string[]>([])
  const [pollRetry, setPollRetry] = useState(0)
  const [refreshingHistory, setRefreshingHistory] = useState(false)
  /**
   * 「历史里要自动播放」的标记：只在成片记录里点「播放」时置位（点完滚上去就直接开播），
   * 其他展示路径（load 自动展示、RECOLOR 完成展示）不置位。
   * ★ 回前台会复位（见 useDidShow）：不复位的话「点过一次播放」
   *   会变成「以后每次回到本页都自动播」。
   */
  const [autoplayOn, setAutoplayOn] = useState(false)
  /**
   * 成片记录默认只展开最近 3 条：记录会越攒越多，全部铺开会把「发布素材」等
   * 后面的模块顶到很深 —— 而用户绝大多数时候只关心最近这几次。
   */
  const [historyOpen, setHistoryOpen] = useState(false)
  /**
   * 整片调色默认**收起**：四根滑块是一屏里最占高度的一块，而多数人录完就出片、
   * 不进调色 —— 收起后点标题才展开滑块（用户要求「点击了才出现调色滑动栏目」）。
   * ★ 收起只是不渲染滑块，`color` 状态与预览请求都不受影响：调好的色值仍在，
   *   顶部播放器照旧显示那条调色预览（见 requestColorPreview 的依赖里没有 colorOpen）。
   */
  const [colorOpen, setColorOpen] = useState(false)
  // P0-5：不可用档位 → 原因文案。空对象表示「都可用」（含能力接口拉取失败时的保守放行）
  const [gradeIssues, setGradeIssues] = useState<Partial<Record<RenderGrade, string>>>({})
  /**
   * 服务端是否开启了配乐生成（`CHATCUT_BGM_ENABLED`）。
   * ★ 默认 false 而不是 true：配乐是生成类调用、服务端默认关着；拉取失败时按「不可选」处理，
   *   宁可少给一个选项，也不要让用户选了「轻柔」却拿到一部没有音乐的成片。
   */
  const [bgmEnabled, setBgmEnabled] = useState(false)
  // 整片调色预览：拖动中显示静帧近似，松手后才请求服务端的整片精确预览
  const [draggingAxis, setDraggingAxis] = useState<keyof ColorGrade | null>(null)
  const [colorPreviewUrl, setColorPreviewUrl] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState('')
  /**
   * 已成功预览过的参数指纹（null = 当前没有可用的调色预览）。
   *
   * ★ 用 state 而不是 ref：它要参与**渲染判断**（决定画面显示静帧近似还是播视频），
   *   放 ref 里改完不触发重渲染，画面会卡在静帧上出不来。
   * ★ 用「当前指纹 vs 已预览指纹」推导「脏」，而不是另开一个 boolean 标志位：
   *   标志位有两处要同步（改参数时置脏、预览成功时洗净），漏一处就是静默错画面
   *   —— 典型表现是松手后画面闪回上一版旧预览。推导出来的值不可能失同步。
   */
  const [previewedSignature, setPreviewedSignature] = useState<string | null>(null)
  /**
   * 「松手了、防抖中的那 0.8s」窗口：请求还没发出，但画面必须已经切到静帧近似。
   *
   * ★ 这个窗口原来是用 `colorDirty`（当前指纹 ≠ 已预览指纹）推导的 —— 那是错的：
   *   「看过成片」（showResult → clearColorPreview ⇒ 指纹置空）之后，只要滑块不是全 0，
   *   推导就恒为真，画面永久停在「正在生成整片精确预览…」，而此时**没有任何请求在飞**、
   *   也没有机制会再发起（已实测复现）。推导值分不清「等请求」和「在看别的内容」，
   *   所以改成显式状态：松手时置位，请求真正发出（或被清空）时复位。
   */
  const [colorReqPending, setColorReqPending] = useState(false)
  /**
   * 提交锁按**档位**分开（不是单一布尔）。
   *
   * ★ 为什么：三档互不干扰之后，用户在 AI 提交尚未返回时可以立刻点基础生成。
   *   单一布尔会让第二次点击命中 `submitLock.current` 后**静默返回** ——
   *   既没提交、也没有任何提示，用户只会觉得「按钮坏了、点了没反应」。
   *   用集合按档位去重，才既防了同档双击、又不吞掉异档提交。
   */
  const submitLock = useRef<Set<RenderGrade>>(new Set())
  /**
   * 发布素材的同步再入锁。`publishLoading` 是 state、要等渲染才生效，而确认弹窗
   * （await showModal）会挂起整个函数 —— 挂起期间第二次点击看到的 loading 仍是 false，
   * 于是两个弹窗、两次「开始生成」、两笔扣费（每次调用都 newRequestId，服务端幂等
   * 按 requestId 去重 ⇒ 新 id 就是新的一笔）。锁必须在 showModal **之前**同步置位。
   */
  const publishLock = useRef(false)
  const recorderRef = useRef<ReturnType<typeof Taro.getRecorderManager> | null>(null)
  const recordingRef = useRef(false)
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previewVersion = useRef(0)
  const colorPreviewVersion = useRef(0)
  const colorPreviewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const loadVersion = useRef(0)
  /**
   * 三档并行 ⇒ 两个派生量，别混用：
   *   · `activeTasks` —— **全部**未收敛的任务。用于「进度卡片」与轮询：漏掉哪一档，
   *     那一档的进度就没人更新（页面停在旧百分比上，看着像卡死）。
   *   · `pendingTask` —— **当前档位**的未收敛任务。只用于判断「这一档现在能不能点生成」：
   *     三档互不干扰是产品约定（AI 档在跑时基础档照样要能提交），所以按钮只该被本档挡住。
   *     ⚠ 这两者用反了就是本轮修的那个 bug（按钮被别的档位锁住）或者进度条不刷新。
   */
  const activeTasks = renders.filter((task) => ACTIVE_STATUS.includes(task.status))
  const pendingTask = activeTasks.find((task) => task.grade === grade) ?? null
  const lastSuccess = renders.find((task) => task.status === 'SUCCESS') ?? null
  /**
   * 「保存到相册」该下载哪条成片。
   *
   * ★ 判据必须落在**产物自身的调色值**上，而不是「参数脏没脏」这类标志位。
   *   标志位有「改参数时置脏、出片后洗净」两处要同步，漏一处就是静默存错片；
   *   而用户这次报的 bug 正是同一型：原实现只认 selectedResult，调色版成片压根没被看过一眼，
   *   于是「调完色点保存」拿到的永远是那条最初的基础成片。比对数值不可能失同步。
   * ★ 四轴全 0 也走同一条规则（它对应「按基础参数出的那条」），特判反而会在
   *   「已经有调色成片、用户又随手把滑块拖回 0」时取错。
   * ★ 优先取用户正在看的那条：他在成片记录里点开某条、色值又恰好一致，就该存那条。
   */
  const colorMatchedTask =
    renders.find((task) => task.status === 'SUCCESS' && !!task.resultKey && sameColor(task.color, color)) ?? null
  let saveTargetTask: RenderTask | null = null
  if (selectedResult && selectedResult.resultKey && sameColor(selectedResult.color, color)) {
    saveTargetTask = selectedResult
  } else if (colorMatchedTask) {
    saveTargetTask = colorMatchedTask
  } else if (isNoopColor(color) && selectedResult?.resultKey) {
    // 调色已被清零：用户要的就是「不调色」，此时不能再拿「当前调色还没出片」拦人。
    // 没有色值全 0 的成片可选（例如第一条成片就带着调色出生），就把画面这条给他。
    saveTargetTask = selectedResult
  }
  /**
   * 素材是否齐全。
   * ★ 两个条件缺一不可：
   *   · `!shot.assetId && !shot.skipped` —— 用户明确跳过（拍摄页「暂不上传」）的分镜不算缺。
   *     漏掉 skipped 的话，跳过等于没跳过：拍摄页允许跳过、这里却把人挡回去，
   *     而拍摄页那个分镜已经显示「已跳过」，用户找不到任何可做的事（死循环）。
   *     跳过状态是**服务端**字段，刷新/换设备都还在（见 services/creation.ts 的 ShotItem.skipped）。
   *   · 至少要有 1 个真素材 —— 全部跳过的极端情况下 missing 为空，
   *     但服务端 buildRenderClips 是「一个 clip 都没有 ⇒ 4003」，放行只会白跑一趟。
   */
  const missingShots = detail?.shots.filter((shot) => !shot.assetId && !shot.skipped) ?? []
  const readyShots = detail?.shots.filter((shot) => !!shot.assetId) ?? []
  /** 被用户明确跳过的分镜：它们不进成片、不计费，但必须显示出来，否则用户会以为素材丢了 */
  const skippedCount = detail?.shots.filter((shot) => shot.skipped).length ?? 0
  const materialsReady = readyShots.length > 0 && missingShots.length === 0

  /**
   * 丢掉当前的调色预览态（并取消待发的防抖请求）。三个场景必须调用它：
   *   ① 用户明确要看别的东西（点分镜、点成片）—— 播放器该换成他点的那条；
   *   ② 有新成片成功产出 —— 成片比调色预览更该被看到；
   *   ③ 离开本页 —— 预览链接是签名过的、会过期，留着下次回来多半播不了。
   * version++ 的作用是让「已经发出去、还在飞」的那次请求回来时被丢弃，
   * 否则它会把刚清掉的状态又写回去（表现为：明明点了成片，过两秒画面又跳回调色预览）。
   */
  const clearColorPreview = useCallback(() => {
    if (colorPreviewTimer.current) {
      clearTimeout(colorPreviewTimer.current)
      colorPreviewTimer.current = undefined
    }
    colorPreviewVersion.current += 1
    setPreviewedSignature(null)
    setColorPreviewUrl(null)
    setPreviewing(false)
    setColorReqPending(false)
    setPreviewError('')
    setDraggingAxis(null)
  }, [])

  const showResult = useCallback(async (task: RenderTask) => {
    clearColorPreview()
    const version = ++previewVersion.current
    setSelectedResult(task)
    // 记下「用户正在看这条」：离开页面时写进快照，回来优先选回它，
    // 而不是永远跳回最新一条成功任务
    resultPrefRef.current = task.id
    setVideoUrl(null)
    setResultError('')
    try {
      if (!task.resultKey) throw new Error('成片地址暂不可用，请刷新重试')
      const result = await getResultPlayUrl(task.resultKey)
      if (version !== previewVersion.current) return
      if (!result.url) throw new Error('成片暂不可播放，请稍后重试')
      setVideoUrl(result.url)
    } catch (error) {
      if (version === previewVersion.current) setResultError((error as Error).message || '获取成片失败，请重试')
    }
  }, [clearColorPreview])

  const load = useCallback(async (targetId?: string | null) => {
    // 显式传编号的调用方（useDidShow）手里那个才是准的：它可能在本次渲染之后才拿到，
    // 而 state 要等下一次渲染才更新，这里若去读 state 就会用旧的 null 把页面判成编号丢失
    const target = targetId ?? idRef.current
    if (!target) { setLoadError('页面编号丢失，请回到「创作」重新进入'); return }
    const version = ++loadVersion.current
    setLoadError('')
    try {
      const [creation, tasks, publishRes] = await Promise.all([
        getCreation(target),
        listRenders(target),
        // ★ 发布素材**不让整页加载失败**：它是"发出去"那一步的产物，视频与生成入口才是主体。
        //   拉不到就当"还没生成过"（下面还有单独的错误提示），绝不能因此白屏。
        getPublishMaterial(target).catch(() => null),
      ])
      if (version !== loadVersion.current) return
      setDetail(creation)
      if (publishRes) {
        setPublishMat(publishRes.material)
        setPublishEstimate(publishRes.estimate)
      }
      const sorted = [...tasks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      setRenders(sorted)
      // 优先恢复离开时正在看的那条；它已不可用（被删/失败）才退回最新一条成功任务
      const preferred = sorted.find((task) => task.id === resultPrefRef.current && task.status === 'SUCCESS')
      const success = preferred ?? sorted.find((task) => task.status === 'SUCCESS')
      if (success) void showResult(success)
    } catch (error) {
      if (version === loadVersion.current) setLoadError((error as Error).message || '加载失败，请重试')
    }
  }, [showResult])

  /**
   * P0-5 档位能力：服务端环境决定 AI 档能不能用（依赖外部剪辑通道配置）。
   * 拉取失败时**保守放行**（不标灰），因为服务端在 freeze 之前还会再硬拒一次（4013），
   * 客户端标灰只是体验优化，不能因为一次网络抖动把档位全锁死。
   */
  const loadCapabilities = useCallback(async () => {
    try {
      const r = await getGradeCapabilities()
      const issues: Partial<Record<RenderGrade, string>> = {}
      for (const g of r.grades) if (!g.available) issues[g.key] = g.reason || '该档位暂不可用'
      setGradeIssues(issues)
      // 配乐开关是**纯增量**字段：老服务端不返回它 ⇒ 保持 false（不选即可，不会误导）
      setBgmEnabled(!!r.chatcut?.bgmEnabled)
      // 当前选中的档位如果已不可用，回退到 BASIC，避免用户点了提交才发现
      setGrade((cur) => (issues[cur] ? 'BASIC' : cur))
    } catch {
      setGradeIssues({})
      setBgmEnabled(false)
    }
  }, [])

  /**
   * 把当前界面落进快照。写成读 ref 的函数，是因为它要被 useDidHide 调用 ——
   * 那是页面不可见的瞬间，读不到当次渲染的最新 state 就白存了。
   */
  const persistSnapshot = useCallback(() => {
    if (snapshotRef.current) writeComposeSnapshot({ ...snapshotRef.current, updatedAt: Date.now() })
  }, [])

  useEffect(() => { idRef.current = id }, [id])

  /**
   * 持续记快照（防抖 400ms）。拖调色滑块会高频改 color，
   * 每拖一格同步写一次 storage 是没必要的 IO；真正不能丢的最后一次由 useDidHide 立刻补写。
   */
  useEffect(() => {
    if (!id) return
    snapshotRef.current = { id, grade, color, resultId: selectedResult?.id ?? null, updatedAt: Date.now() }
    const timer = setTimeout(persistSnapshot, 400)
    return () => clearTimeout(timer)
  }, [id, grade, color, selectedResult?.id, persistSnapshot])

  /** 「本次显示还没找回调色预览」标记，交给 requestColorPreview 之后的那个 effect 消费 */
  const previewRestorePending = useRef(false)

  useDidShow(() => {
    setVisible(true)
    // 自动播放只在「成片记录里点播放」那一次生效，回到本页一律复位
    setAutoplayOn(false)
    // ★ 编号要在页面**每次显示时重新确认**，不能渲染期读一次就定终身：
    //   冷启动恢复时 Taro 重建页面组件，渲染期的 current.router 可能还没挂上，
    //   读到空编号就把页面判成「编号丢失」；而此后若没有任何 state 变化触发重渲染，
    //   页面会一直卡在错误态 —— 用户点一下「重新加载」才好，正是那次点击带来了重渲染。
    //   路由仍然给不出编号时，才用快照里记的那条顶一次（快照只在编号对得上时才被认领）。
    const live = readRouteId(routeParams()) ?? idRef.current ?? boot.snap?.id ?? null
    if (live !== idRef.current) {
      idRef.current = live
      setId(live)
    }
    previewRestorePending.current = true
    void load(live)
    void loadCapabilities()
    void refreshMe().catch(() => setLoadError('账户刷新失败，请重试'))
  })

  useDidHide(() => {
    setVisible(false)
    // 页面可能就此被系统回收，快照必须**立刻**落盘，不能还等那 400ms 防抖
    persistSnapshot()
    loadVersion.current += 1
    previewVersion.current += 1
    // 预览链接是签名过的、会过期，离开就丢掉；下次回来按需重算（服务端有缓存，很快）
    clearColorPreview()
    // 录音同样不能带出本页（navigateTo 走时页面只是隐藏、不会卸载，卸载钩子救不了这条路）：
    // 先清标记再 stop，onStop 走早退分支、不会发起那次孤儿上传
    recordingRef.current = false
    setRecording(false)
    if (recordingTimerRef.current) {
      clearTimeout(recordingTimerRef.current)
      recordingTimerRef.current = null
    }
    try { recorderRef.current?.stop() } catch { /* 没在录音 */ }
  })

  useEffect(() => () => {
    loadVersion.current += 1
    previewVersion.current += 1
    if (colorPreviewTimer.current) clearTimeout(colorPreviewTimer.current)
    // ★ 录音必须随页面终止：RecorderManager 是 App 级单例，不主动 stop 它会继续采集到
    //   60s 上限，然后 onStop 回调照常执行 uploadCustomVoice —— 落一条没有任何提交
    //   会引用的孤儿素材，用户也不知道「为什么还在录音」。
    //   先清标记再 stop：onStop 见 recordingRef 已清会走早退分支，不会触发那次上传。
    recordingRef.current = false
    if (recordingTimerRef.current) {
      clearTimeout(recordingTimerRef.current)
      recordingTimerRef.current = null
    }
    try { recorderRef.current?.stop() } catch { /* 没在录音 */ }
  }, [])

  useEffect(() => {
    Taro.setNavigationBarTitle({ title: '合成成片' })
  }, [])

  /**
   * 发布素材生成中的计时器（只为把"在动"显示出来，见发布素材卡片里 ProgressLine 的说明）。
   * ★ 依赖是 publishLoading：结束时立刻停表并归零，否则下一次生成会从上一秒的位置继续。
   * ★ 必须 clearInterval：小程序页面里漏掉的 interval 会在页面卸载后继续跑，
   *   每 500ms 触发一次 setState（已卸载的组件）—— 这是最典型的"越用越卡"来源。
   */
  useEffect(() => {
    if (!publishLoading) {
      setPubElapsed(0)
      return
    }
    const started = Date.now()
    const timer = setInterval(() => setPubElapsed(Date.now() - started), 500)
    return () => clearInterval(timer)
  }, [publishLoading])

  /**
   * 活跃任务集合的指纹，用作轮询 effect 的依赖。
   * 用**字符串**而不是数组：数组每次渲染都是新引用，effect 会无限重启（每 3 秒重排一次计时器，
   * 轮询实际永远不会按节奏跑）。集合内容不变时这个串不变。
   */
  const activeIdsKey = activeTasks.map((task) => task.id).sort().join(',')

  useEffect(() => {
    if (!visible || !id || activeTasks.length === 0) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    // 本轮要盯的任务集合：取进入本次 effect 时的快照。集合一变（新提交 / 某条收敛）
    // activeIdsKey 就会变，effect 重启后自然拿到新的集合。
    const ids = activeTasks.map((task) => task.id)
    // 轮询必须封顶：服务端 sweeper 正常时任务 30 分钟内一定收敛，但如果 sweeper 挂了 /
    // 任务卡在 sweeper 不认的状态里，客户端原实现会每 3 秒请求一次、永不停止 ——
    // 用户把页面留在后台就是一整晚的网络与电量消耗。超过上限就停下来并明确告知。
    const startedAt = Date.now()
    const POLL_MAX_MS = 30 * 60 * 1000
    setPollError('')
    const poll = async () => {
      try {
        // 逐条查、**单条失败不影响其他条**：一条任务的查询失败（比如刚好被并发清理）
        // 不该让另外两档的进度一起停更。
        const results = await Promise.all(ids.map(async (taskId) => {
          try { return await getRender(id, taskId) } catch { return null }
        }))
        if (cancelled) return
        const latestList = results.filter((item): item is RenderTask => item !== null)
        if (latestList.length === 0) throw new Error('进度查询失败')
        failures = 0
        setPollError('')
        setRenders((tasks) => tasks.map((task) => latestList.find((item) => item.id === task.id) ?? task))
        const finished = latestList.filter((item) => !ACTIVE_STATUS.includes(item.status))
        if (finished.length > 0) {
          // ★ 收敛的任务逐条处理。旧的单任务实现是在这里直接 return 结束轮询的 ——
          //   三档并行之后不能这么干：一条失败就 return，会让仍在跑的另一档进度永远停更。
          //   集合已变 ⇒ activeIdsKey 变 ⇒ effect 会重启并把剩下的活跃任务接着盯。
          for (const item of finished) {
            if (item.status === 'SUCCESS') void showResult(item)
          }
          const failed = finished
            .filter((item) => item.status !== 'SUCCESS')
            .map((item) => `「${gradeTitle(item.grade)}」未完成：${item.errorText || '请在下方成片记录查看，积分以账户记录为准'}`)
          if (failed.length > 0) {
            // 逐条并入而不是覆盖：同一次轮询里两档同时失败时，两条都要留下
            setTaskNotices((list) => {
              const merged = [...list]
              for (const text of failed) if (!merged.includes(text)) merged.push(text)
              return merged
            })
          }
          void refreshMe().catch(() => setPollError('任务已结束，账户刷新失败，请重试'))
          return
        }
        if (Date.now() - startedAt >= POLL_MAX_MS) {
          setPollError('已等待超过 30 分钟，任务仍在后台处理。可先离开此页，稍后在「我的作品」查看结果；若有异常请联系客服。')
          return
        }
      } catch {
        if (cancelled) return
        failures += 1
        setPollError('进度查询失败，任务仍在后台处理，请勿重复提交')
        if (failures >= 3) return
      }
      if (!cancelled) timer = setTimeout(poll, 3000)
    }
    void poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [visible, id, activeIdsKey, pollRetry, refreshMe, showResult])

  /** 浮层里那条请求的代次：连点两条素材时，先回来的旧响应不许覆盖后点开的那条 */
  const shotPreviewVersion = useRef(0)

  /**
   * 点分镜素材 → 就地放大播放。
   *
   * ★ 先把浮层打开（loading 态）再去取地址：取签名地址要 0.3~1s，
   *   等地址回来才出现浮层 = 用户以为没点上，然后又点一次。
   * ★ 不碰 `videoUrl` / `selectedResult`：下方播放窗里正在看的成片或调色预览
   *   **必须留着**，看素材只是"瞟一眼"，关掉浮层要回到原样。
   * ★ 地址每次现取（不缓存）：签名 URL 会过期，缓存到 state 里跨天就是「打不开的黑屏」。
   */
  const openShotPreview = async (shot: { assetId: string | null; seq: number; shotType: string | null }) => {
    if (!shot.assetId) return
    const assetId = shot.assetId
    const version = ++shotPreviewVersion.current
    setShotPreview({ assetId, seq: shot.seq, shotType: shot.shotType || '通用', url: null, error: '' })
    try {
      const result = await getPlayUrl(assetId)
      if (version !== shotPreviewVersion.current) return
      if (!result.url) throw new Error('素材暂不可播放')
      setShotPreview((cur) => (cur && cur.assetId === assetId ? { ...cur, url: result.url! } : cur))
    } catch (error) {
      if (version !== shotPreviewVersion.current) return
      const message = (error as Error).message || '素材播放失败，请重试'
      setShotPreview((cur) => (cur && cur.assetId === assetId ? { ...cur, error: message } : cur))
    }
  }

  const closeShotPreview = () => {
    // 代次 +1：关掉之后，那条还在飞的请求回来也不许把浮层重新打开
    shotPreviewVersion.current += 1
    setShotPreview(null)
  }

  /**
   * 生成发布素材：标题 + 文案 + 封面（`part='COVER'` 时只重出封面）。
   *
   * ★ 先弹确认再发请求：这里是**两笔**钱 —— 封面固定价 + 封面选帧（按 token 计费），
   *   当前配置下合计 900 积分（300 + 600，见 prisma/prompts.ts 的 PUBLISH_SCENES）。
   *   在不知情的情况下花掉一笔相对大的积分，是最容易被投诉的那种体验。
   *   价格取服务端给的 `estimate`，不在客户端写死 —— 后台改价后这里跟着变。
   * ★ 不假装进度：服务端是「出文本 → 抽帧选帧 → 出图」三步**串行**（约 1~2 分钟），
   *   三段都没有可订阅的进度事件，编一个「进度条」只会让人盯着一个假的百分比。
   *   所以只说清「要等多久、在等什么」。
   * ★ 2026-09-24 起，封面底图改为**从拍摄素材里挑一帧真实画面**再做设计
   *   （原来是让模型凭空画）。因此多出「封面选帧」这一笔，
   *   `costText` 与文案都必须把它算进去，否则会出现「说好 480、实扣 1080」。
   */
  const doGeneratePublish = async (part: 'ALL' | 'COVER') => {
    if (!id || publishLoading || publishLock.current) return
    // 同步上锁（见 publishLock 的说明）：此后整条链路 —— 包括等弹窗期间 —— 第二次点击直接挡掉
    publishLock.current = true
    try {
      const cap = publishEstimate?.textBeanCap
      const cover = publishEstimate?.coverBeans
      const pick = publishEstimate?.pickBeans
      const costText =
        part === 'COVER'
          ? `封面选帧最多 ${pick ?? '?'} 积分 + 封面固定 ${cover ?? '?'} 积分`
          : `标题与文案最多 ${cap ?? '?'} 积分 + 封面选帧最多 ${pick ?? '?'} 积分 + 封面固定 ${cover ?? '?'} 积分`
      const { confirm } = await Taro.showModal({
        title: part === 'COVER' ? '重新生成封面' : '生成发布素材',
        content:
          `${costText}。\n大约 1~2 分钟：先从你拍的画面里挑一帧当底图，再出标题与文案，\n` +
          `最后按抖音封面规范做成封面（3:4 竖版）。\n` +
          (part === 'COVER' ? '标题与文案会沿用已生成的那版，不会重复扣费。' : ''),
        confirmText: '开始生成',
        cancelText: '再想想',
      })
      if (!confirm) return

      setPublishLoading(true)
      setPublishError('')
      setPublishNotice('')
      try {
        const r = await generatePublishMaterial(id, newRequestId(), part)
        setPublishMat(r.material)
        // duplicated = 同一 requestId 又打了一次（连点/重试），库里并没有再扣钱
        setPublishNotice(r.duplicated ? '这次是重复提交，没有再扣积分。' : (r.notice ?? ''))
        // 扣过积分就要把底部条的「可用」刷新掉，否则用户会以为没扣
        if (!r.duplicated) void refreshMe()
      } catch (error) {
        setPublishError((error as Error).message || '生成失败，请稍后重试')
      } finally {
        setPublishLoading(false)
      }
    } finally {
      publishLock.current = false
    }
  }

  /**
   * 请求服务端的「整片精确预览」。
   *
   * 触发时机：松手（Slider onChange）之后防抖 0.8s。**拖动过程中绝不发请求** —— 一次预览要跑
   * 一遍整片重编码，跟着拖动频率发等于把服务器当计算器用（服务端也有滑动窗口限流兜底）。
   */
  const requestColorPreview = useCallback(async (next: ColorGrade) => {
    if (!id) return
    // 请求真正接管了（无论后面是发出去、被去重还是被素材不齐挡下），防抖窗口都算结束。
    // 放在所有早退分支之前：否则「拖回已预览过的参数」这类去重命中会让 pending 挂着不复位。
    setColorReqPending(false)
    if (isNoopColor(next)) {
      // 四轴都回到 0 = 没有可预览的变化，服务端会直接 4014 拒掉。客户端先自己收手，
      // 顺手清掉上一次的预览，免得画面上留着「旧的调色」误导人。
      clearColorPreview()
      return
    }
    // 素材不齐时服务端必然 4003，别白跑一趟；页面上方的素材提示已经在引导用户去补素材
    if (!materialsReady) return
    const signature = colorSignature(next)
    if (signature === previewedSignature) return
    const version = ++colorPreviewVersion.current
    setPreviewing(true)
    setPreviewError('')
    try {
      const result = await previewColor(id, next)
      if (version !== colorPreviewVersion.current) return
      if (!result.url) throw new Error('预览地址暂不可用，请重试')
      setPreviewedSignature(signature)
      setColorPreviewUrl(result.url)
    } catch (error) {
      if (version !== colorPreviewVersion.current) return
      // 失败时**不**记指纹：用户什么都不改再点一次「重新预览」应该是真的重试，
      // 而不是被上面那句去重直接挡掉（那样看起来像按钮坏了）。
      setPreviewError((error as Error).message || '预览生成失败，请重试')
    } finally {
      if (version === colorPreviewVersion.current) setPreviewing(false)
    }
  }, [id, materialsReady, previewedSignature, clearColorPreview])

  /**
   * 回到页面时把整片调色预览重新要来。
   *
   * 不补这一次，画面会永远停在「正在生成整片精确预览…」上 —— 那句话本是给 0.8 秒防抖
   * 窗口用的，而离开时预览链接已经被丢掉，不会有任何请求再回来改写它。
   * 服务端按内容寻址缓存，同参数基本秒回，代价可以忽略。
   */
  useEffect(() => {
    if (!previewRestorePending.current) return
    if (!visible || !id || !materialsReady) return
    previewRestorePending.current = false
    if (isNoopColor(color) || colorSignature(color) === previewedSignature) return
    void requestColorPreview(color)
  }, [visible, id, materialsReady, color, previewedSignature, requestColorPreview])

  /**
   * 成片记录里点「播放」之后，**真正把片子放起来**的那一下。
   *
   * 为什么不能只靠 `<Video autoplay={autoplayOn}>`：`autoplay` 是个**状态属性**，在
   * 「同一个 video 节点动态换源」这条路径上不保证肯自己播（组件已经在场且处于暂停态）。
   * 所以地址就绪后再显式 `play()` 一次兜底 —— 已经在播时它是幂等的空操作，
   * 而 `onPlay` 会把标记放掉，所以本 effect 不会反复触发。
   *
   * ★★ 两处位置约束，改这个文件时别挪：
   *   ① 依赖必须是 `videoUrl` / `colorPreviewUrl` 这两个 **state**，不能写渲染期拼出来的
   *      `playUrl` —— 那个 const 声明在 `if (!detail) return` **之后**，进依赖数组 = 渲染期 TDZ。
   *   ② 本 effect 必须待在提前 return **之前**，否则 detail 从 null 变有值时就成了条件 Hook
   *      （"Rendered more hooks than during the previous render"）。
   */
  useEffect(() => {
    if (!autoplayOn || (!videoUrl && !colorPreviewUrl)) return
    // 留一小段：原生 video 节点由 Taro 在本次渲染后创建，取 context 需要它已经在场。
    // 300ms 与上面 pageScrollTo 的滚动时长同量级，观感上是「滚到就开播」。
    const timer = setTimeout(() => {
      try {
        Taro.createVideoContext(PLAYER_VIDEO_ID).play()
      } catch {
        // 取不到 context（节点还没挂上）：不补救，autoplay 属性仍是第一道
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [autoplayOn, videoUrl, colorPreviewUrl])

  /**
   * Slider 的取值入口。分两个相位，这是本功能的核心约定：
   *   · dragging（onChanging，拖动过程中）—— 只更新本地数值，让静帧跟手变色，**不发请求**。
   *   · settled（onChange，松手或点一下）—— 清掉拖动标记，防抖后请求整片精确预览。
   *
   * 拖动中之所以用「静帧 + CSS 近似滤镜」而不是给 <video> 加滤镜：video 是原生组件，
   * 官方明确「样式对原生组件内部无效」，这条路本来就不通（更何况锐化根本没有对应的 CSS 滤镜）。
   */
  const changeColor = (axis: keyof ColorGrade, value: number, phase: 'dragging' | 'settled') => {
    const next = { ...color, [axis]: value }
    setColor(next)
    if (phase === 'dragging') {
      setDraggingAxis(axis)
      return
    }
    setDraggingAxis(null)
    // 防抖窗口开始：请求还没发出，画面先切到静帧近似（见 colorReqPending 的说明）
    setColorReqPending(true)
    if (colorPreviewTimer.current) clearTimeout(colorPreviewTimer.current)
    colorPreviewTimer.current = setTimeout(() => { void requestColorPreview(next) }, COLOR_PREVIEW_DEBOUNCE_MS)
  }

  const resetColor = () => {
    setColor(DEFAULT_COLOR)
    clearColorPreview()
    // 画面要跟着回到「没有调色」的那条成片：不然用户看着上一版调色成片、保存下来的却是基础版，
    // 「所见非所存」要到保存那一刻才暴露，那时已经解释不清了
    const plain = renders.find((task) => task.status === 'SUCCESS' && !!task.resultKey && !!task.color && isNoopColor(task.color))
    if (plain && plain.id !== selectedResult?.id) void showResult(plain)
  }

  const reloadHistory = async () => {
    if (!id || refreshingHistory) return
    setRefreshingHistory(true)
    try {
      const tasks = await listRenders(id)
      setRenders([...tasks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)))
      setPollError('')
    } catch (error) {
      setPollError((error as Error).message || '任务记录刷新失败，请重试')
    } finally {
      setRefreshingHistory(false)
    }
  }

  const uploadCustomVoice = async (filePath: string, sizeBytes?: number, name = '自定义配音') => {
    if (!detail?.storeId || customVoiceUploading) return
    setCustomVoiceUploading(true)
    try {
      const asset = await uploadAudioFile({ filePath, storeId: detail.storeId, sizeBytes })
      setCustomVoice({ cosKey: asset.cosKey, durationMs: asset.durationMs ?? undefined, name })
      setChatcut((value) => ({ ...value, voiceId: 'custom' }))
      Taro.showToast({ title: '自定义配音已添加', icon: 'success' })
    } catch (error) {
      Taro.showToast({ title: (error as Error).message || '配音上传失败', icon: 'none' })
    } finally {
      setCustomVoiceUploading(false)
    }
  }

  const chooseCustomVoice = async () => {
    try {
      const result = await Taro.chooseMessageFile({ count: 1, type: 'file', extension: ['mp3', 'm4a', 'wav', 'aac'] })
      const file = result.tempFiles[0]
      if (file) await uploadCustomVoice(file.path, file.size, file.name)
    } catch {
      // 用户取消选择不提示错误
    }
  }

  const recordCustomVoice = async () => {
    if (customVoiceUploading) return
    const recorder = recorderRef.current ?? Taro.getRecorderManager()
    recorderRef.current = recorder
    if (recordingRef.current) {
      try { recorder.stop() } catch { /* 录音已经结束 */ }
      return
    }
    try {
      await Taro.authorize({ scope: 'scope.record' })
    } catch {
      Taro.showToast({ title: '请允许使用麦克风', icon: 'none' })
      return
    }
    await new Promise<void>((resolve) => {
      recorder.onStop((result) => {
        if (!recordingRef.current) { resolve(); return }
        recordingRef.current = false
        setRecording(false)
        if (recordingTimerRef.current) clearTimeout(recordingTimerRef.current)
        recordingTimerRef.current = null
        void uploadCustomVoice(result.tempFilePath, undefined, '我的录音')
        resolve()
      })
      recordingRef.current = true
      setRecording(true)
      recorder.start({ duration: 60_000, format: 'aac', sampleRate: 44100, numberOfChannels: 1 })
      Taro.showToast({ title: '正在录音，再点停止', icon: 'none', duration: 1500 })
      recordingTimerRef.current = setTimeout(() => {
        try { recorder.stop() } catch { /* 录音已停止 */ }
      }, 60_000)
    })
  }

  const stopCustomVoice = () => {
    if (!recordingRef.current) return
    recordingRef.current = false
    setRecording(false)
    if (recordingTimerRef.current) clearTimeout(recordingTimerRef.current)
    recordingTimerRef.current = null
    try { recorderRef.current?.stop() } catch { /* 录音已经结束 */ }
  }

  /**
   * 滚动到页面顶部的播放器（成片记录里点「播放」之后用）。
   * rect.top 是相对**视口**的坐标，要加上当前滚动偏移换算回页面绝对位置，
   * 再往上留 90rpx 的呼吸空间，别让播放器贴着屏幕上沿。
   */
  const scrollToPlayer = () => {
    const query = Taro.createSelectorQuery()
    query.select('.rcompose__preview').boundingClientRect()
    query.selectViewport().scrollOffset()
    query.exec((res) => {
      const rect = res?.[0] as { top?: number } | null
      const offset = res?.[1] as { scrollTop?: number } | null
      if (!rect || typeof rect.top !== 'number' || !offset || typeof offset.scrollTop !== 'number') return
      void Taro.pageScrollTo({
        scrollTop: Math.max(0, offset.scrollTop + rect.top - 90),
        duration: 300,
      })
    })
  }

  /** 成片记录的「播放」：翻开自动播放标记 → 顶部播放器换成这条 → 滚到播放器 */
  const onPlayInPage = (task: RenderTask) => {
    setAutoplayOn(true)
    void showResult(task)
    scrollToPlayer()
  }

  /**
   * 底部「?」：把结算口径一次说清。
   * 档位系数直接从 GRADE_RATIO 生成，**不在文案里另写一份数字** —— 费率改了这里跟着变，
   * 不会出现「弹窗写着 1.5×、卡片上却是别的数」。
   */
  const showCostHelp = () => {
    const ratios = GRADE_OPTIONS.map((option) => `${option.title} ${GRADE_RATIO[option.key].toFixed(1)}×`).join('、')
    void Taro.showModal({
      title: '积分怎么算',
      content: `参考预估按每秒积分与档位系数计算（${ratios}），按实际时长结算，失败全额返还。`,
      showCancel: false,
      confirmText: '知道了',
    })
  }

  const doRender = async (mode: 'FULL' | 'RECOLOR') => {
    if (!id || !detail || submitLock.current.has(grade)) return
    // ★ 只拦**本档**：三档互不干扰（服务端同样按档位判，见 render.service.ts 的 running 查询）。
    //   这里必须给出提示而不是静默 return —— 按钮虽已置灰，但状态可能刚变（比如另一台设备
    //   提交了同一档），静默返回会表现为「点了没反应」。
    if (pendingTask) {
      setLoadError(`${gradeTitle(grade)}已有任务在进行中，请等它完成后再提交这一档（其他档位不受影响）`)
      return
    }
    if (!materialsReady) {
      // 两种「不齐」的出路完全不同，别用一句话糊过去：
      // · 还有分镜没素材 ⇒ 要么去补拍，要么在拍摄页把它跳过（跳过就不进成片）
      // · 一个素材都没有（被跳光了）⇒ 只能回去至少拍一个，跳过再多也凑不出成片
      setLoadError(
        readyShots.length === 0
          ? '至少要有 1 个分镜的素材才能出片，请先回拍摄页拍一条'
          : `还有 ${missingShots.length} 个分镜没上传素材，请先补齐（不需要的可以在拍摄页跳过它）`,
      )
      return
    }
    if (grade === 'AI' && chatcut.voiceId === 'custom' && !customVoice) {
      setLoadError('请先上传或录制自定义配音，再生成成片')
      return
    }
    // P0-5 纵深防御：UI 已把不可用档位标灰，但状态可能过期（例如页面停留期间服务端改了配置），
    // 这里再拦一道，并顺手刷新一次能力表，避免用户反复点到同一个拒绝。
    if (gradeIssues[grade]) {
      setLoadError(gradeIssues[grade] as string)
      void loadCapabilities()
      return
    }
    submitLock.current.add(grade)
    setSubmittingGrades((list) => (list.includes(grade) ? list : [...list, grade]))
    // 新一次提交 = 新的一轮等待：上一轮的失败通知与查询错误都该收走，
    // 否则新任务刚排上队，页面上还挂着「上次失败」的横幅，看着像这次也失败了。
    setTaskNotices([])
    setPollError('')
    try {
      await refreshMe()
      const account = useMerchantStore.getState()
      if (!account.isMember || Number(account.available) <= 0) {
        const result = await Taro.showModal({
          title: !account.isMember ? '需要订阅' : '积分不足',
          content: '订阅或充值后即可使用生成能力', confirmText: '去订阅充值',
        })
        if (result.confirm) await Taro.navigateTo({ url: '/pages/recharge/index' })
        return
      }
      const cost = estimatePoints(detail.shots, grade, mode === 'RECOLOR')
      const confirmed = await Taro.showModal({
        title: '确认生成',
        content: `参考预估 ${cost} 积分，可用 ${account.available} 积分，按实际结算。`,
        confirmText: '确认提交',
      })
      if (!confirmed.confirm) return
      const { task } = await submitRender(id, {
        mode, grade, color,
        // ★ 让「提交载荷」和「界面说法」逐项对齐，别出现「选了但其实没做」的状态：
        //   · 不配音 ⇒ 字幕与「清理停顿」都没有可转录的音频（服务端会跳过），
        //     这里显式置 false，而不是靠后端静默忽略；
        //   · 配乐开关没开 ⇒ 强制 NONE —— 面板那时不给选项，正常选不到，
        //     但默认值/历史状态可能带着旧值，强制归零最稳。
        chatcut: grade === 'AI'
          ? {
              ...chatcut,
              subtitles: chatcut.subtitleMode !== 'OFF',
              ...(bgmEnabled ? {} : { bgm: 'NONE' as const }),
            }
          : undefined,
        engine: grade === 'AI' ? 'LOCAL' : undefined,
        profile: grade === 'AI' && chatcut.editMode === 'ADVANCED' ? autoEditProfile : undefined,
        ...(grade === 'AI' && chatcut.editMode === 'ADVANCED' && chatcut.voiceId === 'custom' && customVoice
          ? { customVoiceKey: customVoice.cosKey, customVoiceDurationMs: customVoice.durationMs }
          : {}),
        requestId: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      })
      setRenders((tasks) => [task, ...tasks.filter((item) => item.id !== task.id)])
      if (task.status === 'SUCCESS') void showResult(task)
      void refreshMe().catch(() => setLoadError('任务已提交，账户刷新失败，请刷新查看'))
    } catch (error) {
      // ★ 顺序不能反：load() 的同步首段就有 setLoadError('')，先 set 再 void load()
      //   会在同一次事件循环里把刚写上的错误抹成空串 —— 横幅根本不显示。
      //   而请求层对「网络层失败」（断网/超时）又不弹 toast，这条横幅是用户唯一的反馈。
      await load()
      setLoadError((error as Error).message || '提交失败，请刷新任务列表后重试')
    } finally {
      submitLock.current.delete(grade)
      setSubmittingGrades((list) => list.filter((item) => item !== grade))
    }
  }

  /**
   * 「画面上的调色还没有对应成片」时唯一的出路。
   *
   * ★ 为什么不能直接存画面里那条：整片调色预览是 ultrafast/crf32 的低码率示意
   *   （server/src/render/preview.ts 的 PREVIEW_ENCODE），存进相册不报错、只是很糊 ——
   *   用户根本不会发现，这才是最坏的结果。所以这里明确挡住，并把出口指出来。
   */
  const offerColorRender = async () => {
    if (grade !== 'BASIC') {
      setResultError('整片调色只对「基础生成」生效。要保存调色效果，请先切回基础生成并出片。')
      return
    }
    if (pendingTask) {
      setResultError(`「${gradeTitle(grade)}」有任务正在处理中，等它完成就能保存这一版成片。`)
      return
    }
    const cost = estimatePoints(detail?.shots ?? [], grade, true)
    const { confirm } = await Taro.showModal({
      title: '调色还没出片',
      content: `低码率预览不能存进相册，请先按当前调色出片（约 ${cost} 积分）。`,
      confirmText: '去出片',
      cancelText: '知道了',
    })
    if (confirm) await doRender('RECOLOR')
  }

  /**
   * 解析保存/复制真正要下载的地址。返回 null 表示**本次不发请求**
   * （已经在引导出片、或已经把原因写进提示），不是一个需要再报一次的失败。
   */
  const resolveSaveUrl = async (): Promise<string | null> => {
    const target = saveTargetTask
    if (!target) { await offerColorRender(); return null }
    try {
      const result = await getResultPlayUrl(target.resultKey!)
      if (!result.url) { setResultError('下载地址暂不可用，请稍后重试'); return null }
      return result.url
    } catch (error) {
      setResultError((error as Error).message || '下载地址获取失败，请稍后重试')
      return null
    }
  }

  const saveResult = async () => {
    if (saving) return
    setSaving(true)
    setResultError('')
    try {
      const url = await resolveSaveUrl()
      if (!url) return
      const file = await Taro.downloadFile({ url })
      if (file.statusCode !== 200) { setResultError('下载失败，请重试'); return }
      await Taro.saveVideoToPhotosAlbum({ filePath: file.tempFilePath })
      void Taro.showToast({ title: '已保存到相册', icon: 'success' })
    } catch {
      // 能走到这里的都是小程序原生失败（绝大多数是相册权限被拒），原文案对用户没有意义
      setResultError('保存失败：请在小程序设置里允许「保存到相册」。')
    } finally { setSaving(false) }
  }

  /**
   * 复制一段文本（标题 / 文案）。
   * ★ 交不出内容时也要说句话：静默什么也不做，会被当成「这个按钮是坏的」。
   */
  const copyText = async (text: string, label: string) => {
    if (!text) { void Taro.showToast({ title: `还没有${label}`, icon: 'none' }); return }
    try {
      await Taro.setClipboardData({ data: text })
      void Taro.showToast({ title: `${label}已复制`, icon: 'success' })
    } catch {
      void Taro.showToast({ title: '复制失败，请重试', icon: 'none' })
    }
  }

  /**
   * 长按封面 → 保存到相册。
   * ★ 与保存视频同理：`saveImageToPhotosAlbum` 只吃**本地临时文件**，必须先 `downloadFile`；
   *   直接喂 https 地址会失败，而报错是原生的一句英文，对用户毫无指导意义。
   * ★ 失败绝大多数是「相册权限被拒」，且**只有第一次**会弹授权框 —— 所以给一句能照着做的指引。
   */
  const saveCover = async () => {
    const url = publishMat?.coverUrl
    if (!url) return
    try {
      const file = await Taro.downloadFile({ url })
      if (file.statusCode !== 200) { void Taro.showToast({ title: '下载失败，请重试', icon: 'none' }); return }
      await Taro.saveImageToPhotosAlbum({ filePath: file.tempFilePath })
      void Taro.showToast({ title: '已保存到相册', icon: 'success' })
    } catch {
      void Taro.showToast({ title: '请允许「保存到相册」', icon: 'none', duration: 2500 })
    }
  }

  // 出错时的按钮要**分情况**：编号丢了的话「重新加载」只会再错一次，
  // 那是个假出路；这时唯一有意义的动作是回列表重进。
  if (!detail) {
    return (
      <View className='rcompose__tip'>
        {loadError || '加载中…'}
        {!!loadError &&
          (id ? (
            <Button onClick={() => void load()}>重新加载</Button>
          ) : (
            <Button onClick={() => Taro.switchTab({ url: '/pages/creation/list' })}>回到创作列表</Button>
          ))}
      </View>
    )
  }
  const cost = estimatePoints(detail.shots, grade)
  const previewedGrade = selectedResult ? gradeTitle(selectedResult.grade) : ''
  // 拖动中的近似预览需要一张静帧来承载 CSS 滤镜，取第一张有封面的分镜。
  // 用静帧而不是「当前正在播的某一帧」，是因为 video 是原生组件、内部渲染吃不到样式 ——
  // 这是刻意的取舍，不是图省事。
  const stillCover = detail.shots.find((shot) => shot.assetId && shot.coverUrl)?.coverUrl ?? null
  /**
   * 显示静帧近似的条件，要盖住从「按下滑块」到「精确预览拿到」的**整段**窗口：
   * 拖动中 → 松手后的 0.8s 防抖等待（colorReqPending）→ 请求中 → 请求失败（配错误提示收尾）。
   * ⚠ 中间那段最容易漏：松手时 draggingAxis 已清空、而 previewing 要等防抖到期才置起，
   *   少一项就会在这 ≤0.8s 里闪回上一版旧预览 —— 看着像操作失败。
   * ★ 这段窗口**只能**用显式状态表达（见 colorReqPending 的说明）：用「指纹不等」推导
   *   会把「正在看某条成片」也算成脏，画面永久停在「正在生成…」而没有任何请求在飞。
   * materialsReady 也是必要条件：素材不齐时预览不会发起（服务端 4003），
   *   否则静帧会一直停在「正在生成…」上不动。
   * 本地 AI 引擎与基础引擎共用同一套调色管线，因此 AI 档也可以生成精确调色预览。
   */
  const showingStill =
    materialsReady && !!stillCover && (draggingAxis !== null || colorReqPending || previewing || !!previewError)
  const showingColorPreview = !showingStill && !!colorPreviewUrl
  const playUrl = colorPreviewUrl ?? videoUrl
  const previewBadge = showingStill ? '调色近似' : showingColorPreview ? '调色预览' : `${previewedGrade}${clipPrepSuffix(selectedResult)}`
  const stillLabel = draggingAxis !== null ? '松手后生成整片精确预览' : '正在生成整片精确预览…'
  // 本地自动剪辑与基础生成共用归一化、拼接和调色管线；ChatCut 仅作为显式外部实验通道。
  const colorUnsupported = false
  return (
    <View className='rcompose'>
      {/* ★ 2026-09-24 按需求删除页面顶部的深色框体（rcompose__stage）：框内标题与
          「这一步做什么」问号一起下线。 */}
      <View className='rcompose__head'>
        <View className='rcompose__headmain'>
          <Text className='rcompose__title'>{detail.title || '未命名创作'}</Text>
          <Text className='rcompose__store'>{detail.store?.name}</Text>
        </View>
        <Text className={`rcompose__materials ${missingShots.length === 0 ? 'rcompose__materials--ok' : ''}`}>
          素材 {readyShots.length}/{detail.shots.length}
          {skippedCount > 0 ? ` · 跳过 ${skippedCount}` : ''}
          {missingShots.length === 0 ? ' ✓' : ''}
        </Text>
      </View>

      {/* ── 分镜素材 ── 默认收起（见 clipsOpen 的说明）。
          ★ 展开开关**只做在右侧那个按钮上**，标题行整行不绑定点击：
            「去上传素材」按钮就在同一行里，若把 onClick 挂在父容器上，
            在小程序里按钮的 tap 会冒泡到父节点 ⇒ 点「去上传」会顺手把列表收起来。
            （stopPropagation 在 weapp 里不可靠，所以从结构上避开，而不是靠它。） */}
      <View className='rcompose__card rcompose__card--lead rcompose__card--clips'>
        <View className='rcompose__history-heading'>
          <Text className='rcompose__sectitle'>分镜素材 · 已上传 {readyShots.length}/{detail.shots.length}</Text>
          {/* 「缺哪几个分镜」不再用文字说一遍 —— 缺素材的格子自己就写着「缺素材」，重复只是噪音。
              但「去上传」这个**入口**必须留着：素材不齐就点不了「生成成片」，
              没了入口用户只能退回上一页找路。 */}
          {!materialsReady && (
            <Button size='mini' onClick={() => Taro.navigateTo({ url: `/pages/creation/shots?id=${id}` })}>去上传素材</Button>
          )}
          {/* 用 View 而不是 Text 承载点击：Text 的 props 里没有 hoverClass，
              而这两个要点的元素都需要按压反馈（微信下没有 hover 态会像"点不动"） */}
          <View
            className='rcompose__clipstoggle'
            hoverClass='ds-hover'
            onClick={() => setClipsOpen((v) => !v)}
          >
            <Text>{clipsOpen ? '收起 ▴' : '展开 ▾'}</Text>
          </View>
        </View>
        {/* 只在「没有素材」时给一句该去干什么。
            ★ 有素材时**不写**「展开可以逐个看画面…」：那是在向用户解释他点开就会看到的事，
              属于噪音；「有没有素材」才是他此刻真正需要知道的信息。 */}
        {!clipsOpen && readyShots.length === 0 && (
          <Text className='rcompose__clipshint'>还没有可用素材，先去把分镜拍完。</Text>
        )}
        {clipsOpen && (
        <View className='rcompose__clips'>
          {detail.shots.map((shot) => (
            <View className='rcompose__clip' key={shot.id}>
              {/* 整块缩略图可点即就地放大播放（浮层），见 openShotPreview 的说明。
                  两列布局里放不下一个独立的「预览」按钮，居中的播放角标已经说明它能点 */}
              <View className='rcompose__clipthumbwrap' onClick={() => void openShotPreview(shot)}>
                {shot.assetId && shot.coverUrl ? (
                  <Image className='rcompose__clipthumb' mode='aspectFill' src={shot.coverUrl} />
                ) : (
                  <View className='rcompose__clipthumbph'>
                    {/* 跳过与「还没传」必须分开说：两种格子长得一样时，
                        用户会把「我跳过的那几个」当成「素材丢了」，然后一处处去查 */}
                    <Text className='rcompose__clipthumbtip'>{shot.skipped ? '已跳过' : shot.assetId ? '缩略图生成中' : '缺素材'}</Text>
                  </View>
                )}
                {shot.assetId && <View className='rcompose__clipplay' />}
                {/* 序号压在缩略图左上角：只留「序号 / 标题 / 标签」三项，让序号单独占一行太浪费 */}
                <Text className='rcompose__clipseq'>{shot.seq}</Text>
              </View>
              {/* 只留标题 + 标签。口播文案（shot.line）本页不再展示 —— 这一块是「挑素材看效果」用的，
                  要读文案该去分镜页 */}
              <Text className='rcompose__cliptype'>{shot.shotType || '通用'}</Text>
              {(!!shot.shotSize || !!shot.durationSuggest) && (
                <View className='rcompose__cliptags'>
                  {!!shot.shotSize && <Text className='rcompose__clipmeta'>{shot.shotSize}</Text>}
                  {!!shot.durationSuggest && <Text className='rcompose__clipmeta'>建议 {shot.durationSuggest}s</Text>}
                </View>
              )}
            </View>
          ))}
        </View>
        )}
      </View>

      {/* ── 预览 ── 这里只放「成片 / 整片调色预览」；分镜素材改成点开浮层就地播放（见 openShotPreview），
          不再占用这个窗口 —— 否则看一条素材就要把正在看的成片顶掉 */}
      <View className='rcompose__preview'>
        {showingStill ? (
          <>
            {/* 拖动中/请求中的近似预览：CSS 滤镜是「乘法 + 曲线」体系，与服务端 ffmpeg（YUV）
                必然有偏差（见 cssApproxFilter 的说明），所以角标写「调色近似」。 */}
            <Image
              className='rcompose__video'
              mode='aspectFit'
              src={stillCover!}
              style={{ filter: cssApproxFilter(color) }}
            />
            <View className='rcompose__stillo'>{stillLabel}</View>
          </>
        ) : playUrl ? (
          /* ★ `autoplay` 是**状态**，不是一次性事件：所以播起来就把标记放掉（见 onPlay）
             —— 不清的话「点过一次播放」会退化成「此后每条新地址都自动播」（调色预览完成、
             回本页重新展示都会自己响起来）。清掉还顺带修好「再点同一条」：标记 false→true
             的跳变会重新触发，而 `showResult` 每次都先置空地址再换新地址，也带同一个跳变。 */
          <Video
            id={PLAYER_VIDEO_ID}
            className='rcompose__video'
            src={playUrl}
            controls
            autoplay={autoplayOn}
            onPlay={() => setAutoplayOn(false)}
            onError={() => setResultError('播放失败，请重试获取地址')}
          />
        ) : (
          <View className='rcompose__placeholder'>
            {selectedResult ? '成片地址暂不可用，请稍后重试' : '生成成片后在这里播放（素材在展开后点一下就地放大）'}
          </View>
        )}
        {!!previewBadge && <Text className='rcompose__preview-badge'>{previewBadge}</Text>}
      </View>

      {previewError && (
        <View className='ds-notice rcompose__notice'>
          <Text>
            {previewError}
            {stillCover ? '（画面为近似示意，未反映精确调色）' : ''}
          </Text>
          <Button size='mini' onClick={() => void requestColorPreview(color)}>重新预览</Button>
        </View>
      )}

      {resultError && <View className='ds-notice rcompose__notice'>{resultError}</View>}

      {selectedResult && (
        <View className='rcompose__actions'>
          {/* ★ 只留「保存到相册」。删掉的两个各有原因：
              · 「重新播放」——视频播放器自带 controls，重播不需要第二个入口；
              · 「复制链接」——它复制的是**现签的临时地址**（getResultPlayUrl），
                过一会儿就失效，用户拿它去别处下载只会得到一个打不开的链接。 */}
          <Button className='rcompose__action' size='mini' loading={saving} disabled={saving} onClick={saveResult}>保存到相册</Button>
        </View>
      )}

      {loadError && (
        <View className='ds-notice rcompose__notice'>
          <Text>{loadError}</Text>
          <Button size='mini' onClick={() => { void load(); void refreshMe().catch(() => setLoadError('账户刷新失败')) }}>刷新</Button>
        </View>
      )}

      {/* ── 生成方式 ── */}
      <View className='rcompose__card rcompose__card--generation'>
        <Text className='rcompose__sectitle'>生成方式</Text>
        <View className='rcompose__grades'>
          {GRADE_OPTIONS.map((option) => {
            const issue = gradeIssues[option.key]
            const off = !!issue
            return (
              <View
                key={option.key}
                className={`rcompose__grade ${grade === option.key ? 'rcompose__grade--on' : ''} ${off ? 'rcompose__grade--off' : ''}`}
                onClick={() => {
                  if (off) {
                    Taro.showToast({ title: issue, icon: 'none', duration: 2500 })
                    return
                  }
                  // 换档就丢掉调色预览：AI 档根本不应用调色参数，
                  // 留着上一档的「调色预览」播在那儿会让人以为 AI 也会带上这套调色。
                  if (option.key !== grade) clearColorPreview()
                  setGrade(option.key)
                }}
              >
                <Text className='rcompose__gradetitle'>{option.title}</Text>
                {off ? (
                  <Text className='rcompose__graderatio'>即将开放</Text>
                ) : (
                  <Text className='rcompose__graderatio'>{GRADE_RATIO[option.key].toFixed(1)}×</Text>
                )}
              </View>
            )
          })}
        </View>
        {!!gradeIssues[grade] && (
          <View className='ds-notice ds-notice--warn rcompose__premiumtip'>{gradeIssues[grade]}</View>
        )}
      </View>

      {grade === 'AI' && (
        <View className='rcompose__card rcompose__card--ai'>
          <View className='rcompose__titlerow'>
            <Text className='rcompose__sectitle'>AI 自动剪辑</Text>
            <SectionHelp
              title='AI 自动剪辑'
              text='服务器会分析素材内容、画面质量和口播关系，自动选择镜头与节奏。'
            />
          </View>
          <View className='rcompose__choice'>
            <View className='rcompose__fieldrow'>
              <Text className='rcompose__fieldlabel'>剪辑模式</Text>
              <SectionHelp
                title='剪辑模式'
                text='AI 默认模式：不添加 AI 配音，保留素材原声并自动生成字幕；系统会识别镜头类型、语音节奏和转场，优先保证语句完整与音画同步。高级模式：可自选配音、字幕样式、节奏与转场等细节。'
              />
            </View>
            <View className='rcompose__choices'>
              <Text className={`rcompose__choiceitem ${chatcut.editMode === 'AUTO' ? 'rcompose__choiceitem--on' : ''}`} onClick={() => setChatcut((value) => ({ ...value, editMode: 'AUTO' }))}>AI 默认模式</Text>
              <Text className={`rcompose__choiceitem ${chatcut.editMode === 'ADVANCED' ? 'rcompose__choiceitem--on' : ''}`} onClick={() => setChatcut((value) => ({ ...value, editMode: 'ADVANCED' }))}>高级模式</Text>
            </View>
          </View>
          {chatcut.editMode === 'AUTO' ? null : (
            <>
          <View className='rcompose__choice'>
            <View className='rcompose__fieldrow'>
              <Text className='rcompose__fieldlabel'>剪辑内容类型</Text>
              <SectionHelp title='剪辑内容类型' text='不确定时选择自动识别，系统会根据整组素材判断。' />
            </View>
            <View className='rcompose__choices'>
              {AUTO_EDIT_PROFILE_OPTIONS.map((option) => (
                <Text
                  key={option.label}
                  className={`rcompose__choiceitem ${autoEditProfile === option.value ? 'rcompose__choiceitem--on' : ''}`}
                  onClick={() => setAutoEditProfile(option.value)}
                >
                  {option.label}
                </Text>
              ))}
            </View>
          </View>
          <View className='rcompose__fieldrow'>
            <Text className='rcompose__fieldlabel'>配音音色</Text>
            <SectionHelp
              title='配音音色'
              text='系统音色即选即用；选「自定义」可用自己的录音或音频文件，自定义配音会优先于服务器音色，并作为整条旁白使用。'
            />
          </View>
          <View className='rcompose__voicegrid'>
            {CHATCUT_VOICES.map((voice) => (
              <View
                key={voice.id}
                className={`rcompose__voice ${chatcut.voiceId === voice.id ? 'rcompose__voice--on' : ''}`}
                onClick={() => setChatcut((value) => ({
                  ...value,
                  voiceId: voice.id,
                  subtitleMode: voice.id === 'none' && value.subtitleMode === 'VOICE' ? 'SOURCE_AUDIO' : value.subtitleMode,
                }))}
              >
                <Text className='rcompose__voicename'>{voice.name}</Text>
              </View>
            ))}
          </View>
          {chatcut.voiceId === 'custom' && (
            <View className='rcompose__customvoice'>
              <View className='rcompose__voiceactions'>
                <Button size='mini' loading={customVoiceUploading} onClick={() => void chooseCustomVoice()}>选择音频</Button>
                <Button size='mini' type={recording ? 'warn' : 'default'} onClick={recording ? stopCustomVoice : () => void recordCustomVoice()}>
                  {recording ? '停止录音' : '开始录音'}
                </Button>
              </View>
              {customVoice && (
                <View className='rcompose__customvoiceline'>
                  <Text className='rcompose__optiondesc'>{customVoice.name}</Text>
                  <Text className='rcompose__colorreset' onClick={() => setCustomVoice(null)}>移除</Text>
                </View>
              )}
              {!customVoice && !customVoiceUploading && <Text className='rcompose__optiondesc'>请先选择音频或录制一段配音。</Text>}
            </View>
          )}

          <View className='rcompose__optionrow'>
            <View className='rcompose__titlerow'>
              <Text className='rcompose__optiontitle'>显示字幕</Text>
              {/* 说明收进「?」：这一行右列是 Switch，常驻的小字会把开关和它自己的
                  间距一起撑高，而「字幕能不能认原声」是按需了解的事。 */}
              <SectionHelp title='显示字幕' text='字幕独立于配音，可识别视频原声。' />
            </View>
            <Switch checked={chatcut.subtitleMode !== 'OFF'} onChange={(event) => setChatcut((value) => ({ ...value, subtitles: event.detail.value, subtitleMode: event.detail.value ? (voiceOff ? 'SOURCE_AUDIO' : 'VOICE') : 'OFF' }))} color='#e1251b' />
          </View>
          {chatcut.subtitleMode !== 'OFF' && (
            <>
              <View className='rcompose__choice'>
                <Text className='rcompose__fieldlabel'>字幕来源</Text>
                <View className='rcompose__choices'>
                  {(['VOICE', 'SOURCE_AUDIO', 'VOICE_AND_SOURCE'] as const).map((value) => (
                    <Text key={value} className={`rcompose__choiceitem ${chatcut.subtitleMode === value ? 'rcompose__choiceitem--on' : ''}`} onClick={() => setChatcut((item) => ({ ...item, subtitleMode: value, subtitles: true }))}>
                      {SUBTITLE_MODE_LABEL[value]}
                    </Text>
                  ))}
                </View>
              </View>
              <View className='rcompose__choice'>
                <Text className='rcompose__fieldlabel'>字幕样式</Text>
                <View className='rcompose__choices'>
                  {(['CLEAN', 'EMPHASIS', 'SOCIAL'] as const).map((value) => (
                    <Text key={value} className={`rcompose__choiceitem ${chatcut.subtitleStyle === value ? 'rcompose__choiceitem--on' : ''}`} onClick={() => setChatcut((item) => ({ ...item, subtitleStyle: value }))}>
                      {SUBTITLE_STYLE_LABEL[value]}
                    </Text>
                  ))}
                </View>
              </View>
            </>
          )}

          <View className='rcompose__choice'>
            <Text className='rcompose__fieldlabel'>剪辑节奏</Text>
            <View className='rcompose__choices'>
              {(['NATURAL', 'FAST', 'STORY'] as const).map((value) => (
                <Text key={value} className={`rcompose__choiceitem ${chatcut.pacing === value ? 'rcompose__choiceitem--on' : ''}`} onClick={() => setChatcut((item) => ({ ...item, pacing: value }))}>
                  {{ NATURAL: '自然', FAST: '紧凑', STORY: '叙事' }[value]}
                </Text>
              ))}
            </View>
          </View>
          <View className='rcompose__choice'>
            <Text className='rcompose__fieldlabel'>转场效果</Text>
            <View className='rcompose__choices'>
              {(['CLEAN', 'SMOOTH', 'DYNAMIC'] as const).map((value) => (
                <Text key={value} className={`rcompose__choiceitem ${chatcut.transitions === value ? 'rcompose__choiceitem--on' : ''}`} onClick={() => setChatcut((item) => ({ ...item, transitions: value }))}>
                  {{ CLEAN: '硬切', SMOOTH: '柔和溶解', DYNAMIC: '动态擦除' }[value]}
                </Text>
              ))}
            </View>
          </View>
          <View className='rcompose__optionrow'>
            <View className='rcompose__titlerow'><Text className='rcompose__optiontitle'>统一音量</Text><SectionHelp title='统一音量' text='统一原声和配音的响度，减少忽大忽小。' /></View>
            <Switch checked={chatcut.normalizeAudio} onChange={(event) => setChatcut((value) => ({ ...value, normalizeAudio: event.detail.value }))} color='#e1251b' />
          </View>
          <View className='rcompose__optionrow'>
            <View className='rcompose__titlerow'><Text className='rcompose__optiontitle'>清理停顿</Text><SectionHelp title='清理停顿' text='压缩过长静音，保留正常语句节奏。' /></View>
            <Switch checked={chatcut.removeSilence} onChange={(event) => setChatcut((value) => ({ ...value, removeSilence: event.detail.value }))} color='#e1251b' />
          </View>

          <Text className='rcompose__fieldlabel'>备注与关键字</Text>
          <Textarea className='rcompose__note' maxlength={300} placeholder='例如：突出招牌菜、适合小红书种草' value={chatcut.note} onInput={(event) => setChatcut((value) => ({ ...value, note: event.detail.value }))} />
            </>
          )}
        </View>
      )}

      {/* ── 整片调色 ──
          默认收起（`colorOpen`）：四根滑块是这一屏里最占高度的一块，而多数人录完就出片。
          点标题行才展开滑块。★ 收起时仍保留「重置」—— 调过色的用户不必展开就能一键回默认。 */}
      {grade !== 'PREMIUM' && (
        <View className='rcompose__card rcompose__card--color'>
          <View
            className='rcompose__colorhead'
            hoverClass='ds-hover'
            onClick={() => setColorOpen((value) => !value)}
          >
            <View className='rcompose__titlerow'>
              <Text className='rcompose__sectitle rcompose__sectitle--flush'>整片调色</Text>
              <SectionHelp
                title='整片调色'
                text='拖动时画面只是近似示意（锐化在拖动中不体现）。松手约 1 秒后生成整片精确预览，免费。'
              />
            </View>
            {/* ★ 这两个可点项都在「展开开关」里面，各自必须 stopPropagation：
                weapp 下 View 的 tap 会冒泡，否则点「重置」会顺手把模块收起来。 */}
            <View className='rcompose__colorheadright'>
              {!colorUnsupported && !isNoopColor(color) && (
                <Text
                  className='rcompose__colorreset'
                  onClick={(event) => { event.stopPropagation(); resetColor() }}
                >
                  重置
                </Text>
              )}
              <Text className='rcompose__colorchevron'>{colorOpen ? '收起' : '展开'}</Text>
            </View>
          </View>
          {colorOpen && (
            <View className='rcompose__colorbody'>
              {colorUnsupported ? (
                <View className='ds-notice ds-notice--warn'>
                  AI 生成暂不支持整片调色：该档由云端智能剪辑直接出片，调色参数不会被应用。需要调色请改选「基础生成」。
                </View>
              ) : (
                <>
                  {COLOR_AXES.map(([axis, label]) => (
                    <View className='rcompose__slider' key={axis}>
                      <Text className='rcompose__slabel'>{label}</Text>
                      <Slider
                        className='rcompose__sbar'
                        min={-100}
                        max={100}
                        value={color[axis]}
                        showValue
                        activeColor='#e1251b'
                        blockSize={22}
                        // 拖动中只改本地数值、给静帧上近似滤镜；松手才发请求拿整片精确预览。
                        // showValue 照旧开着：数值本身就是最准的一档反馈。
                        onChanging={(event: { detail: { value: number } }) => changeColor(axis, event.detail.value, 'dragging')}
                        onChange={(event: { detail: { value: number } }) => changeColor(axis, event.detail.value, 'settled')}
                      />
                    </View>
                  ))}
                  {/* 素材不齐时的那句是「现在该做什么」的引导，保留常驻；机制说明已收进标题旁的「?」 */}
                  {!materialsReady && (
                    <Text className='rcompose__colorhint'>补齐全部分镜素材后即可生成整片调色预览。</Text>
                  )}
                </>
              )}
            </View>
          )}
        </View>
      )}

      {/* ── 进行中的任务 ──
          三档互不干扰 ⇒ 可能同时有多条，因此必须**逐条列出**（不能像以前那样只显示 find 到的第一条）：
          少列一条，用户就会以为那一档没提交成功，然后再点一次 —— 服务端虽然会拦（4001），
          但用户看到的是「点了没反应 + 一条报错」，体验很差。
          每张卡片都带档位名：「合成中」在一页里出现两次而不说是哪一档，等于没说。 */}
      {activeTasks.map((task) => (
        <View className='rcompose__card rcompose__card--active' key={task.id}>
          <View className='rcompose__history-heading'>
            <Text className='rcompose__sectitle'>{gradeTitle(task.grade)}{clipPrepSuffix(task)} · 进行中</Text>
          </View>
          <ProgressLine
            percent={task.progress}
            label={STATUS_LABEL[task.status] || task.status}
            hint={task.deadlineAt ? `预计交付 ${formatMinute(task.deadlineAt)}` : '处理中，请保持页面打开'}
          />
        </View>
      ))}
      {/* 任务收敛失败的通知：与「查询类」的 pollError 分开展示 —— 它们清空的时机不同
          （见 taskNotices 的声明处），合并成一个 state 会让另一档的成功轮询擦掉这一档的失败原因。 */}
      {taskNotices.map((text) => (
        <View className='ds-notice rcompose__notice' key={text}>
          <Text>{text}</Text>
        </View>
      ))}
      {pollError && (
        <View className='ds-notice rcompose__notice'>
          <Text>{pollError}</Text>
          <Button
            size='mini'
            onClick={() => {
              setTaskNotices([])
              setPollError('')
              setPollRetry((value) => value + 1)
              void load()
            }}
          >
            重新查询
          </Button>
        </View>
      )}

      {/* ── 成片记录 ──
          ★ 默认只展示最近 3 条（新任务在数组头部，unshift + 按时间倒序），
            更早的折叠在一行「展开」后面 —— 记录会越攒越多，全部铺开会把
            「发布素材」等后续模块顶到很深。 */}
      {renders.length > 0 && (
        <View className='rcompose__card rcompose__card--history'>
          <View className='rcompose__history-heading'>
            <View className='rcompose__titlerow'>
              <Text className='rcompose__sectitle'>成片记录</Text>
              <SectionHelp
                title='成片记录'
                text='每次提交生成都会留下一条记录（含积分结算）。点左侧描述可进详情页；成功的成片点「播放」直接在本页顶部播放。'
              />
            </View>
            <Button className='rcompose__headbtn' size='mini' loading={refreshingHistory} disabled={refreshingHistory} onClick={() => void reloadHistory()}>刷新</Button>
          </View>
          {(historyOpen ? renders : renders.slice(0, 3)).map((task) => (
            <View className='rcompose__history' key={task.id}>
              {/* ── 可点区域 = 左半边的「描述块」，里面**不含任何按钮** ──
                  ★ 为什么不把整行做成可点：行里还有「播放」按钮，而小程序里
                    子元素的 tap 会冒泡到父节点（stopPropagation 不可靠），
                    整行可点 = 点播放会顺带跳走。把点击区与按钮区做成**兄弟**节点，
                    结构上就没有冒泡关系。 */}
              <View
                className='rcompose__history-main'
                hoverClass='ds-hover'
                onClick={() =>
                  Taro.navigateTo({ url: `/pages/render/result?id=${task.creationId}&task=${task.id}` })
                }
              >
                <View className='rcompose__history-top'>
                  <Text className='rcompose__history-title'>{gradeTitle(task.grade)}{clipPrepSuffix(task)}</Text>
                  <Text
                    className={`ds-pill ${
                      task.status === 'SUCCESS'
                        ? 'ds-pill--green'
                        : task.status === 'FAILED' || task.status === 'TIMEOUT'
                          ? 'ds-pill--red-soft'
                          : 'ds-pill--gold'
                    }`}
                  >
                    {STATUS_LABEL[task.status] || task.status}
                  </Text>
                </View>
                <Text className='rcompose__history-meta'>
                  {formatMinute(task.finishAt || task.createdAt)} · {task.status === 'SUCCESS' ? '结算' : '任务积分'} {task.beanCharged} 积分
                </Text>
                {/* ★ 只读 errorText（服务端已脱敏），**绝不**去读原始 error_msg：
                    那条里会有第三方产品名、服务端本机绝对路径、HTTP 报文原文。详见
                    apps/mini/src/services/render.ts 里 errorText 的说明。 */}
                {task.errorText && <Text className='rcompose__history-err'>{task.errorText}</Text>}
                <Text className='rcompose__history-go'>
                  {task.status === 'SUCCESS' ? '看视频 / 发布素材 ›' : '查看详情 ›'}
                </Text>
              </View>
              {task.status === 'SUCCESS' && (
                <Button className='rcompose__action rcompose__action--play' size='mini' onClick={() => onPlayInPage(task)}>播放</Button>
              )}
            </View>
          ))}
          {/* 折叠开关只在真有多余记录时出现；文案给出确切条数，让「展开」有预期 */}
          {renders.length > 3 && (
            <View
              className='rcompose__history-toggle'
              hoverClass='ds-hover'
              onClick={() => setHistoryOpen((v) => !v)}
            >
              {historyOpen ? '收起记录' : `展开其余 ${renders.length - 3} 条`}
              <Text className='rcompose__history-toggle-arrow'>{historyOpen ? '▲' : '▼'}</Text>
            </View>
          )}
        </View>
      )}

      {/* ── 发布素材：标题 / 封面 / 文案 ──
          放在成片记录之后，因为它是整条链路的**最后一步**（视频出来了才谈发布包装）。
          ★ 它依赖的是**口播文案**（服务端会重新读一遍创作的门店/菜品上下文），
            与档位、调色都无关 —— 所以没有必要跟三档/调色并排挤在一起。 */}
      <View className='rcompose__card rcompose__card--publish'>
        <View className='rcompose__history-heading'>
          <View className='rcompose__titlerow'>
            <Text className='rcompose__sectitle'>发布素材</Text>
            <SectionHelp
              title='发布素材'
              text='按这条视频的口播文案，生成可以直接发布的三样东西：标题、3:4 竖版封面、发布文案。'
            />
          </View>
          {!!publishMat && !publishLoading && (
            <Button className='rcompose__headbtn' size='mini' onClick={() => void doGeneratePublish('ALL')}>重新生成</Button>
          )}
        </View>

        {!publishMat && !publishLoading && (
          <>
            <Button
              className='ds-btn ds-btn--primary rcompose__pubbtn'
              onClick={() => void doGeneratePublish('ALL')}
            >
              生成发布素材
            </Button>
          </>
        )}

        {publishLoading && (
          <>
            <Text className='rcompose__pubhint'>
              正在生成：先从你拍好的画面里挑一帧，再写标题与文案，最后做成封面。大约需要 1~2 分钟，请不要离开本页。
            </Text>
            {/* ★ 这里用「按耗时估算」的进度而不是无反馈的转圈：服务端没有可订阅的进度事件，
                但三步耗时量级稳定（实测：文本 ~10s / 选帧 6~20s / 出图 30~85s），所以估算是有信息量的。
                percent 封顶 95 —— 永远不能显示 100%，那等于在结果回来之前宣称已完成。
                ★ 分界是「阶段耗时量级」的近似，不是精确切片；分母取 120s 而不是 60s：
                  加了「抽帧选帧」这一步之后典型总耗时已到 1~2 分钟，用 60s 会让进度条
                  在真实完成前就贴住 95% 不动，反而更像卡死。
                ⚠ 改服务端任一步的超时/耗时，这里的三段分界与分母要跟着看（见 services/publish-material.ts
                  的 PUBLISH_TIMEOUT_MS 注释，那里是超时的唯一真源）。 */}
            <ProgressLine
              percent={Math.min(95, (pubElapsed / 120_000) * 100)}
              label={
                pubElapsed < 30_000
                  ? '正在写标题与文案…'
                  : pubElapsed < 60_000
                    ? '正在从你拍的画面里挑封面底图…'
                    : '正在出封面（3:4 竖版）…'
              }
              hint='进度按实测耗时估算，通常 1~2 分钟完成'
            />
          </>
        )}

        {!!publishMat && (
          <>
            {publishMat.coverUrl ? (
              <>
                {/* 封面就地能看、能存 —— 点一下放大（微信预览页里还能再长按保存），长按直接存相册。
                    不必再为了存一张图跳到详情页。
                    ★ previewImage 要把被点的那张放在 urls[0]：`current` 靠「能在 urls 里精确
                      匹配到」定位，匹配不上会**静默回落到第一张**（见 pages/dish/edit.tsx 的说明）；
                      这里只有一张，天然满足。 */}
                <Image
                  className='rcompose__pubcover'
                  mode='aspectFill'
                  src={publishMat.coverUrl}
                  onClick={() => Taro.previewImage({ current: publishMat.coverUrl!, urls: [publishMat.coverUrl!] })}
                  onLongPress={() => void saveCover()}
                />
              </>
            ) : (
              <View className='rcompose__pubcoverph'>
                <Text className='rcompose__pubcoverphtext'>
                  {publishMat.coverError || '封面还没生成出来'}
                </Text>
                <Button size='mini' onClick={() => void doGeneratePublish('COVER')}>重试封面</Button>
              </View>
            )}

            <View className='rcompose__pubblock'>
              {/* ★ 复制做成明确的按钮，而不是只依赖划选：手机上想一次选中一整段标题/文案很难，
                  划选失败会让人以为「复制不了」。 */}
              <View className='rcompose__pubblockhead'>
                <Text className='rcompose__publabel'>标题</Text>
                <Text className='rcompose__pubcopy' onClick={() => void copyText(publishMat.title, '标题')}>复制</Text>
              </View>
              <Text className='rcompose__pubtitle'>{publishMat.title || '（空）'}</Text>
            </View>

            <View className='rcompose__pubblock'>
              <View className='rcompose__pubblockhead'>
                <Text className='rcompose__publabel'>文案</Text>
                <Text className='rcompose__pubcopy' onClick={() => void copyText(publishMat.caption, '文案')}>复制</Text>
              </View>
              <Text className='rcompose__pubcaption'>{publishMat.caption || '（空）'}</Text>
            </View>
          </>
        )}

        {/* 兜底与失败提示：不显示的话，用户会以为"模型就这水平"或者"封面就是这样" */}
        {!!publishMat?.degraded && (
          <Text className='rcompose__puberr'>
            这次的标题与文案是简单拼出来的（AI 没给出可用结果），可以点「重新生成」再试一次。
          </Text>
        )}
        {!!publishNotice && !publishLoading && <Text className='rcompose__pubnotice'>{publishNotice}</Text>}
        {!!publishError && <Text className='rcompose__puberr'>{publishError}</Text>}
      </View>

      {/* ── 分镜素材：就地放大播放的浮层 ──
          ★ 结构上刻意分成「背景遮罩」和「视频卡片」两个**兄弟**节点，而不是
            「卡片里 stopPropagation」：weapp 里 tap 的冒泡由原生 `bindtap` 决定，
            Taro 的 `e.stopPropagation()` 并不能可靠地拦住它 —— 而拦不住的后果是
            「点播放键 / 进度条 → 浮层被关掉」，还是个间歇性复现的问题。
            兄弟节点没有冒泡关系，卡片上的任何点击都到不了遮罩。
          ★ 视频只在 url 就绪后才挂载：`autoplay` 必须在挂载时就带上（weapp 下
            「先挂 Video 再改 src」不会自动播），所以这里用一个三元把挂载时机钉住。 */}
      {shotPreview && (
        <View className='rcompose__lightbox'>
          <View className='rcompose__lightboxmask' onClick={closeShotPreview} />
          <View className='rcompose__lightboxcard'>
            <View className='rcompose__lightboxhead'>
              <Text className='rcompose__lightboxtitle'>
                分镜 {shotPreview.seq} · {shotPreview.shotType}
              </Text>
              <View className='rcompose__lightboxclose' hoverClass='ds-hover' onClick={closeShotPreview}>
                <Text>关闭</Text>
              </View>
            </View>
            {shotPreview.url ? (
              <Video
                className='rcompose__lightboxvideo'
                src={shotPreview.url}
                controls
                autoplay
                objectFit='contain'
                onError={() => setShotPreview((cur) => (cur ? { ...cur, error: '播放失败，请重试' } : cur))}
              />
            ) : (
              <View className='rcompose__lightboxph'>
                <Text className='rcompose__lightboxphtext'>{shotPreview.error || '正在取素材…'}</Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* ── 底部：积分预估 + 生成 ── */}
      <View className='ds-footer'>
        <View className='rcompose__bar'>
          <View className='rcompose__cost'>
            <View className='rcompose__costnum'>
              <Text className='rcompose__cost-label'>约</Text>
              <Text className='rcompose__cost-value ds-num'>{cost}</Text>
              <Text className='rcompose__cost-unit'>积分</Text>
            </View>
            <Text className='rcompose__balance'>
              可用 {available} · {isMember ? '已订阅' : '未订阅，生成前需开通'}
            </Text>
          </View>
          {/* 那一行结算口径的小字收进这个问号：常驻时占掉一行高度却几乎没人读，
              而底部条是固定定位 —— 省下的高度就是内容区的高度。点开才展开（原生弹窗，不挤压布局）。 */}
          <View className='rcompose__help' hoverClass='ds-hover' onClick={showCostHelp}>
            <t-icon name='help-circle' size='38rpx' color='#8e939a' />
          </View>
          <Button
            className='ds-btn ds-btn--primary rcompose__render'
            hoverClass='ds-hover'
            loading={submitting}
            // ★ disabled 只看**本档**（pendingTask 已按当前 grade 过滤）：
            //   别的档位在跑不该锁住这个按钮 —— 这正是本轮要修的交互。
            disabled={submitting || !!pendingTask || !materialsReady}
            onClick={() => void doRender('FULL')}
          >
            {pendingTask ? '正在生成中' : lastSuccess ? '重新生成' : '生成成片'}
          </Button>
        </View>
      </View>
    </View>
  )
}
