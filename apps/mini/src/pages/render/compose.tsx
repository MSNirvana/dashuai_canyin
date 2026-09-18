import { useEffect, useRef, useState, useCallback } from 'react'
import { View, Text, Button, Slider, Video, Image, Switch, Textarea } from '@tarojs/components'
import Taro, { useDidShow, useDidHide } from '@tarojs/taro'
import { getCreation, type CreationDetail } from '../../services/creation'
import {
  submitRender, listRenders, getRender, getPlayUrl, getResultPlayUrl, getGradeCapabilities, previewColor,
  type RenderTask, type RenderGrade, type ColorGrade, type ChatCutOptions, CHATCUT_VOICES,
} from '../../services/render'
import { useMerchantStore } from '../../store/merchant'
import { readRouteId, isNumericId } from '../../utils/route-id'
// 时间一律走这里：接口给的是 UTC 的 ISO 串（…T…Z），直接渲染/截串都会露 T、Z 且差 8 小时
import { formatMinute } from '../../utils/time'
import ProgressLine from '../../components/progress-line'
import './compose.scss'

const DEFAULT_COLOR: ColorGrade = { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 }
const GRADE_RATIO: Record<RenderGrade, number> = { BASIC: 1, AI: 1.5, PREMIUM: 3 }
const DEFAULT_CHATCUT: ChatCutOptions = {
  voiceId: 'warm-female', subtitles: true, subtitleStyle: 'CLEAN', bgm: 'LIGHT',
  pacing: 'NATURAL', transitions: 'CLEAN', removeSilence: true, normalizeAudio: true, note: '',
}
const GRADE_OPTIONS = [
  { key: 'BASIC' as const, title: '基础生成', desc: '粗剪拼接 + 调色' },
  { key: 'AI' as const, title: 'AI 生成', desc: 'AI 配音 + 字幕' },
  { key: 'PREMIUM' as const, title: '精品生成', desc: '剪辑师人工精剪' },
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
  const [renders, setRenders] = useState<RenderTask[]>([])
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [selectedResult, setSelectedResult] = useState<RenderTask | null>(null)
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
  // P0-5：不可用档位 → 原因文案。空对象表示「都可用」（含能力接口拉取失败时的保守放行）
  const [gradeIssues, setGradeIssues] = useState<Partial<Record<RenderGrade, string>>>({})
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
   * 提交锁按**档位**分开（不是单一布尔）。
   *
   * ★ 为什么：三档互不干扰之后，用户在 AI 提交尚未返回时可以立刻点基础生成。
   *   单一布尔会让第二次点击命中 `submitLock.current` 后**静默返回** ——
   *   既没提交、也没有任何提示，用户只会觉得「按钮坏了、点了没反应」。
   *   用集合按档位去重，才既防了同档双击、又不吞掉异档提交。
   */
  const submitLock = useRef<Set<RenderGrade>>(new Set())
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
   * 「保存到相册 / 复制链接」该下载哪条成片。
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
  const missingShots = detail?.shots.filter((shot) => !shot.assetId) ?? []
  const materialsReady = !!detail?.shots.length && missingShots.length === 0

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
      const [creation, tasks] = await Promise.all([getCreation(target), listRenders(target)])
      if (version !== loadVersion.current) return
      setDetail(creation)
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
      // 当前选中的档位如果已不可用，回退到 BASIC，避免用户点了提交才发现
      setGrade((cur) => (issues[cur] ? 'BASIC' : cur))
    } catch {
      setGradeIssues({})
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
  })

  useEffect(() => () => {
    loadVersion.current += 1
    previewVersion.current += 1
    if (colorPreviewTimer.current) clearTimeout(colorPreviewTimer.current)
  }, [])

  useEffect(() => {
    Taro.setNavigationBarTitle({ title: '合成成片' })
  }, [])

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

  /**
   * 把播放窗滚进视野（**仅当它当前不在屏幕上**）。
   *
   * 「分镜素材」在播放窗**上方**，列表一长、或用户正停在列表中部时，播放窗其实在屏幕外 ——
   * 点缩略图会「看着没反应」，用户以为按钮坏了。所以预览前先把播放窗露出来。
   * ★ 已经在视野里就**绝不滚**：无条件滚动会把用户当前位置顶掉，列表短时尤其恼人。
   * ★ 注意 boundingClientRect 的 top/bottom 是**视口相对**坐标（不是文档坐标），
   *   所以直接和 windowHeight 比即可，不需要再叠一次 scrollTop。
   */
  const revealPreview = () => {
    Taro.createSelectorQuery()
      .select('#rcompose-preview')
      .boundingClientRect()
      .exec((res) => {
        const rect = res[0] as { top: number; bottom: number } | null
        if (!rect) return
        const windowHeight = Taro.getWindowInfo().windowHeight
        if (rect.top >= 0 && rect.bottom <= windowHeight) return
        void Taro.pageScrollTo({ selector: '#rcompose-preview', duration: 260 })
      })
  }

  const previewShot = async (assetId: string) => {
    clearColorPreview()
    const version = ++previewVersion.current
    setSelectedResult(null)
    setVideoUrl(null)
    setResultError('')
    // 先滚再拉地址：等待期间用户就能看到播放窗，不至于「点了没反应」
    revealPreview()
    try {
      const result = await getPlayUrl(assetId)
      if (version !== previewVersion.current) return
      if (!result.url) throw new Error('素材暂不可播放')
      setVideoUrl(result.url)
    } catch (error) {
      if (version === previewVersion.current) setResultError((error as Error).message || '素材播放失败，请重试')
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
    if (!materialsReady) { setLoadError('请先补齐全部分镜素材'); return }
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
          content: '订阅后可使用生成能力，积分按实际时长和档位结算。', confirmText: '去订阅充值',
        })
        if (result.confirm) await Taro.navigateTo({ url: '/pages/recharge/index' })
        return
      }
      const cost = estimatePoints(detail.shots, grade, mode === 'RECOLOR')
      const confirmed = await Taro.showModal({
        title: '确认生成',
        content: `参考预估 ${cost} 积分，可用 ${account.available} 积分。按实际时长及后台费率结算，失败后的积分以账户记录为准。`,
        confirmText: '确认提交',
      })
      if (!confirmed.confirm) return
      const { task } = await submitRender(id, {
        mode, grade, color,
        chatcut: grade === 'AI' ? chatcut : undefined,
        requestId: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      })
      setRenders((tasks) => [task, ...tasks.filter((item) => item.id !== task.id)])
      if (task.status === 'SUCCESS') void showResult(task)
      void refreshMe().catch(() => setLoadError('任务已提交，账户刷新失败，请刷新查看'))
    } catch (error) {
      setLoadError((error as Error).message || '提交失败，请刷新任务列表后重试')
      void load()
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
      content: `画面里的调色效果是低码率预览，不能存进相册。先按当前调色重新出片（参考 ${cost} 积分，按实际时长结算），出片完成后回到本页即可保存。`,
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

  const copyDownload = async () => {
    setResultError('')
    const url = await resolveSaveUrl()
    if (!url) return
    try { await Taro.setClipboardData({ data: url }) }
    catch (error) { setResultError((error as Error).message || '复制下载链接失败') }
  }

  const saveResult = async () => {
    if (saving) return
    setSaving(true)
    setResultError('')
    try {
      const url = await resolveSaveUrl()
      if (!url) return
      const file = await Taro.downloadFile({ url })
      if (file.statusCode !== 200) { setResultError('下载失败，请重试或改用「复制链接」'); return }
      await Taro.saveVideoToPhotosAlbum({ filePath: file.tempFilePath })
      void Taro.showToast({ title: '已保存到相册', icon: 'success' })
    } catch {
      // 能走到这里的都是小程序原生失败（绝大多数是相册权限被拒），原文案对用户没有意义
      setResultError('保存失败，请检查相册权限，或改用「复制链接」自行下载。')
    } finally { setSaving(false) }
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
  // 「当前参数还没被精确预览过」⇒ 该显示静帧近似。全 0 不算脏：那时根本没有可预览的变化。
  const colorDirty = !isNoopColor(color) && colorSignature(color) !== previewedSignature
  /**
   * 显示静帧近似的条件，要盖住从「按下滑块」到「精确预览拿到」的**整段**窗口：
   * 拖动中 → 松手后的 0.8s 防抖等待 → 请求中 → 请求失败（配错误提示收尾）。
   * ⚠ 中间那段最容易漏：松手时 draggingAxis 已清空、而 previewing 要等防抖到期才置起，
   *   少一项就会在这 ≤0.8s 里闪回上一版旧预览 —— 看着像操作失败。
   * materialsReady 也是必要条件：素材不齐时预览不会发起（服务端 4003），
   *   否则静帧会一直停在「正在生成…」上不动。
   * ⚠ AI 档必须排除：该档不渲染调色滑块，带着基础档的非 0 参数切过来时 previewedSignature
   *   已被清空 ⇒ colorDirty 恒为 true，而没有任何请求会再回来洗净它，画面就永久停在静帧上
   *   （角标还写着「正在生成整片精确预览…」，等于骗人）。
   */
  const showingStill =
    grade !== 'AI' && materialsReady && !!stillCover && (draggingAxis !== null || colorDirty || previewing || !!previewError)
  const showingColorPreview = !showingStill && !!colorPreviewUrl
  const playUrl = colorPreviewUrl ?? videoUrl
  const previewBadge = showingStill ? '调色近似' : showingColorPreview ? '调色预览' : previewedGrade
  const stillLabel = draggingAxis !== null ? '松手后生成整片精确预览' : '正在生成整片精确预览…'
  // AI 档的调色参数**不会被应用**：worker 在 aiMode 下直接把成片交给 ChatCut 出片然后 return
  // （server/src/render/worker.ts 的 processTask），调色只作用于「基础生成」。
  // 所以这里不摆一组按了也不起作用的滑块 —— 有反应但没效果，比干脆说明更糟。
  const colorUnsupported = grade === 'AI'
  return (
    <View className='rcompose'>
      <View className='rcompose__stage'>
        <Text className='rcompose__stage-kicker'>STEP 3 OF 3 · FINISH</Text>
        <Text className='rcompose__stage-title'>把素材剪成一条能发布的视频</Text>
        <Text className='rcompose__stage-desc'>选择生成方式，确认预计消耗后提交。失败会全额返还积分。</Text>
      </View>
      <View className='rcompose__head'>
        <View className='rcompose__headmain'>
          <Text className='rcompose__title'>{detail.title || '未命名创作'}</Text>
          <Text className='rcompose__store'>{detail.store?.name}</Text>
        </View>
        <Text className={`rcompose__materials ${missingShots.length === 0 ? 'rcompose__materials--ok' : ''}`}>
          素材 {detail.shots.length - missingShots.length}/{detail.shots.length} {missingShots.length === 0 ? '✓' : ''}
        </Text>
      </View>

      {/* ── 分镜素材 ── 放在播放窗**上方**：点缩略图 → 紧邻的下方播放窗出片。
          原来它在整页最底部（在生成方式/调色/任务/成片记录之后），点了要看结果得先滚半页 ——
          点缩略图「像没反应」的根因就在这儿。卡片紧跟页头，所以用 --lead 去掉重复的 24rpx 上边距
          （页头自己已经有 padding-bottom: 24rpx）。 */}
      <View className='rcompose__card rcompose__card--lead'>
        <View className='rcompose__history-heading'>
          <Text className='rcompose__sectitle'>分镜素材 · 已上传 {detail.shots.length - missingShots.length}/{detail.shots.length}</Text>
          {/* 「缺哪几个分镜」不再用文字说一遍 —— 缺素材的格子自己就写着「缺素材」，重复只是噪音。
              但「去上传」这个**入口**必须留着：素材不齐就点不了「生成成片」，
              没了入口用户只能退回上一页找路。 */}
          {!materialsReady && (
            <Button size='mini' onClick={() => Taro.navigateTo({ url: `/pages/creation/shots?id=${id}` })}>去上传素材</Button>
          )}
        </View>
        {/* 一行两个。格子宽按 50% − 半个列间距算、不写死 rpx：卡片内外边距一改，
            写死的宽度就会把第二个挤到下一行（同 dish/detail 的三列写法） */}
        <View className='rcompose__clips'>
          {detail.shots.map((shot) => (
            <View className='rcompose__clip' key={shot.id}>
              {/* 整块缩略图可点即预览：两列布局里放不下一个独立的「预览」按钮，
                  居中的播放角标已经说明它能点（点下去能否看见由 revealPreview() 保证） */}
              <View className='rcompose__clipthumbwrap' onClick={() => shot.assetId && previewShot(shot.assetId!)}>
                {shot.assetId && shot.coverUrl ? (
                  <Image className='rcompose__clipthumb' mode='aspectFill' src={shot.coverUrl} />
                ) : (
                  <View className='rcompose__clipthumbph'>
                    <Text className='rcompose__clipthumbtip'>{shot.assetId ? '缩略图生成中' : '缺素材'}</Text>
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
      </View>

      {/* ── 预览 ── id 供 revealPreview() 定位用，别删 */}
      <View className='rcompose__preview' id='rcompose-preview'>
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
          <Video className='rcompose__video' src={playUrl} controls autoplay={false} onError={() => setResultError('播放失败，请重试获取地址')} />
        ) : (
          <View className='rcompose__placeholder'>
            {selectedResult ? '成片地址暂不可用，请稍后重试' : '点击上方分镜素材可预览视频'}
          </View>
        )}
        {!!previewBadge && <Text className='rcompose__preview-badge'>{previewBadge}</Text>}
      </View>

      {showingColorPreview && (
        <Text className='rcompose__previewtip'>
          已按当前参数出好整片预览（低码率，仅用于确认效果）。满意后点下方「按当前调色重新出片」得到正式成片。
        </Text>
      )}

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
          <Button className='rcompose__action' size='mini' onClick={() => void showResult(selectedResult)}>重新播放</Button>
          <Button className='rcompose__action' size='mini' loading={saving} disabled={saving} onClick={saveResult}>保存到相册</Button>
          <Button className='rcompose__action' size='mini' onClick={copyDownload}>复制链接</Button>
        </View>
      )}

      {loadError && (
        <View className='ds-notice rcompose__notice'>
          <Text>{loadError}</Text>
          <Button size='mini' onClick={() => { void load(); void refreshMe().catch(() => setLoadError('账户刷新失败')) }}>刷新</Button>
        </View>
      )}

      {/* ── 生成方式 ── */}
      <View className='rcompose__card'>
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
                <Text className='rcompose__gradedesc'>{option.desc}</Text>
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
        {grade === 'PREMIUM' && (
          <View className='ds-notice ds-notice--warn rcompose__premiumtip'>提交后进入人工队列，可在本页查看进度与交付结果。</View>
        )}
      </View>

      {grade === 'AI' && (
        <View className='rcompose__card'>
          <Text className='rcompose__sectitle'>AI 成片选项</Text>
          <Text className='rcompose__fieldlabel'>选择配音</Text>
          <View className='rcompose__voicegrid'>
            {CHATCUT_VOICES.map((voice) => (
              <View key={voice.id} className={`rcompose__voice ${chatcut.voiceId === voice.id ? 'rcompose__voice--on' : ''}`} onClick={() => setChatcut((value) => ({ ...value, voiceId: voice.id }))}>
                <Text className='rcompose__voicename'>{voice.name}</Text>
                <Text className='rcompose__voicedesc'>{voice.desc}</Text>
              </View>
            ))}
          </View>
          <View className='rcompose__optionrow'>
            <View><Text className='rcompose__optiontitle'>显示字幕</Text><Text className='rcompose__optiondesc'>将分镜口播同步到画面</Text></View>
            <Switch checked={chatcut.subtitles} onChange={(event) => setChatcut((value) => ({ ...value, subtitles: event.detail.value }))} color='#e1251b' />
          </View>
          {chatcut.subtitles && <View className='rcompose__choice'><Text className='rcompose__fieldlabel'>字幕样式</Text><View className='rcompose__choices'>{(['CLEAN', 'EMPHASIS', 'SOCIAL'] as const).map((value) => <Text key={value} className={`rcompose__choiceitem ${chatcut.subtitleStyle === value ? 'rcompose__choiceitem--on' : ''}`} onClick={() => setChatcut((item) => ({ ...item, subtitleStyle: value }))}>{value === 'CLEAN' ? '简洁' : value === 'EMPHASIS' ? '重点强调' : '社交风格'}</Text>)}</View></View>}
          <View className='rcompose__choice'><Text className='rcompose__fieldlabel'>配乐</Text><View className='rcompose__choices'>{(['NONE', 'LIGHT', 'UPBEAT', 'PREMIUM'] as const).map((value) => <Text key={value} className={`rcompose__choiceitem ${chatcut.bgm === value ? 'rcompose__choiceitem--on' : ''}`} onClick={() => setChatcut((item) => ({ ...item, bgm: value }))}>{value === 'NONE' ? '无配乐' : value === 'LIGHT' ? '轻柔' : value === 'UPBEAT' ? '活力' : '高级感'}</Text>)}</View></View>
          <View className='rcompose__choice'><Text className='rcompose__fieldlabel'>剪辑节奏</Text><View className='rcompose__choices'>{(['NATURAL', 'FAST', 'STORY'] as const).map((value) => <Text key={value} className={`rcompose__choiceitem ${chatcut.pacing === value ? 'rcompose__choiceitem--on' : ''}`} onClick={() => setChatcut((item) => ({ ...item, pacing: value }))}>{value === 'NATURAL' ? '自然' : value === 'FAST' ? '明快' : '叙事'}</Text>)}</View></View>
          <View className='rcompose__choice'><Text className='rcompose__fieldlabel'>转场风格</Text><View className='rcompose__choices'>{(['CLEAN', 'SMOOTH', 'DYNAMIC'] as const).map((value) => <Text key={value} className={`rcompose__choiceitem ${chatcut.transitions === value ? 'rcompose__choiceitem--on' : ''}`} onClick={() => setChatcut((item) => ({ ...item, transitions: value }))}>{value === 'CLEAN' ? '干净利落' : value === 'SMOOTH' ? '平滑自然' : '动感切换'}</Text>)}</View></View>
          <View className='rcompose__optionrow'><View><Text className='rcompose__optiontitle'>清理停顿</Text><Text className='rcompose__optiondesc'>自动剪掉口播之间的空白</Text></View><Switch checked={chatcut.removeSilence} onChange={(event) => setChatcut((value) => ({ ...value, removeSilence: event.detail.value }))} color='#e1251b' /></View>
          <View className='rcompose__optionrow'><View><Text className='rcompose__optiontitle'>统一音量</Text><Text className='rcompose__optiondesc'>平衡配音、原声与配乐响度</Text></View><Switch checked={chatcut.normalizeAudio} onChange={(event) => setChatcut((value) => ({ ...value, normalizeAudio: event.detail.value }))} color='#e1251b' /></View>
          <Text className='rcompose__fieldlabel'>备注与关键字</Text>
          <Textarea className='rcompose__note' maxlength={300} placeholder='例如：突出招牌菜、适合小红书种草' value={chatcut.note} onInput={(event) => setChatcut((value) => ({ ...value, note: event.detail.value }))} />
        </View>
      )}

      {/* ── 整片调色 ── */}
      {grade !== 'PREMIUM' && (
        <View className='rcompose__card'>
          <View className='rcompose__colorhead'>
            <Text className='rcompose__sectitle rcompose__sectitle--flush'>整片调色</Text>
            {!colorUnsupported && !isNoopColor(color) && (
              <Text className='rcompose__colorreset' onClick={resetColor}>重置</Text>
            )}
          </View>
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
              <Text className='rcompose__colorhint'>
                {materialsReady
                  ? '拖动时画面只是近似示意（锐化在拖动中不体现）。松手约 1 秒后生成整片精确预览，免费。'
                  : '补齐全部分镜素材后即可生成整片调色预览。'}
              </Text>
            </>
          )}
        </View>
      )}

      {/* ── 进行中的任务 ──
          三档互不干扰 ⇒ 可能同时有多条，因此必须**逐条列出**（不能像以前那样只显示 find 到的第一条）：
          少列一条，用户就会以为那一档没提交成功，然后再点一次 —— 服务端虽然会拦（4001），
          但用户看到的是「点了没反应 + 一条报错」，体验很差。
          每张卡片都带档位名：「合成中」在一页里出现两次而不说是哪一档，等于没说。 */}
      {activeTasks.map((task) => (
        <View className='rcompose__card' key={task.id}>
          <View className='rcompose__history-heading'>
            <Text className='rcompose__sectitle'>{gradeTitle(task.grade)} · 进行中</Text>
          </View>
          <ProgressLine
            percent={task.progress}
            label={STATUS_LABEL[task.status] || task.status}
            hint={task.deadlineAt ? `预计交付 ${formatMinute(task.deadlineAt)}` : '处理中，请保持页面打开'}
          />
        </View>
      ))}
      {activeTasks.length > 0 && (
        <Text className='rcompose__colorhint'>三个档位互不影响，其他档位现在也可以提交生成。</Text>
      )}
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

      {/* ── 成片记录 ── */}
      {renders.length > 0 && (
        <View className='rcompose__card'>
          <View className='rcompose__history-heading'>
            <Text className='rcompose__sectitle'>成片记录</Text>
            <Button size='mini' loading={refreshingHistory} disabled={refreshingHistory} onClick={() => void reloadHistory()}>刷新</Button>
          </View>
          {renders.map((task) => (
            <View className='rcompose__history' key={task.id}>
              <View className='rcompose__history-top'>
                <Text className='rcompose__history-title'>{gradeTitle(task.grade)}</Text>
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
              {task.status === 'SUCCESS' && (
                <Button className='rcompose__action' size='mini' onClick={() => void showResult(task)}>播放成片</Button>
              )}
            </View>
          ))}
        </View>
      )}

      {/* 「重新导出」入口：复用归一化缓存，只跑「拼接 + 一遍调色」，所以比首次合成便宜。
          只在已有 BASIC 成片、且当前仍选 BASIC 时出现 —— RECOLOR 的语义是「把上一版成片重调色」，
          没有可复用的成片时这条路径不成立。 */}
      {lastSuccess && grade === 'BASIC' && (
        <Button
          className='rcompose__recolor'
          loading={submitting}
          disabled={submitting || !!pendingTask || !materialsReady}
          onClick={() => void doRender('RECOLOR')}
        >
          按当前调色重新出片（参考 {estimatePoints(detail.shots, grade, true)} 积分）
        </Button>
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
