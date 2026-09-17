import { useEffect, useRef, useState, useCallback } from 'react'
import { View, Text, Button, Slider, Video, Image, Switch, Textarea } from '@tarojs/components'
import Taro, { useDidShow, useDidHide } from '@tarojs/taro'
import { getCreation, type CreationDetail } from '../../services/creation'
import {
  submitRender, listRenders, getRender, getPlayUrl, getResultPlayUrl, getGradeCapabilities, previewColor,
  type RenderTask, type RenderGrade, type ColorGrade, type ChatCutOptions, CHATCUT_VOICES,
} from '../../services/render'
import { useMerchantStore } from '../../store/merchant'
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
  const id = Taro.getCurrentInstance().router?.params.id
  const { available, isMember, refreshMe } = useMerchantStore()
  const [detail, setDetail] = useState<CreationDetail | null>(null)
  const [color, setColor] = useState<ColorGrade>(DEFAULT_COLOR)
  const [grade, setGrade] = useState<RenderGrade>('BASIC')
  const [chatcut, setChatcut] = useState<ChatCutOptions>(DEFAULT_CHATCUT)
  const [renders, setRenders] = useState<RenderTask[]>([])
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [selectedResult, setSelectedResult] = useState<RenderTask | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [visible, setVisible] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [resultError, setResultError] = useState('')
  const [pollError, setPollError] = useState('')
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
  const submitLock = useRef(false)
  const previewVersion = useRef(0)
  const colorPreviewVersion = useRef(0)
  const colorPreviewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const loadVersion = useRef(0)
  const pendingTask = renders.find((task) => ACTIVE_STATUS.includes(task.status)) ?? null
  const lastSuccess = renders.find((task) => task.status === 'SUCCESS') ?? null
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

  const load = useCallback(async () => {
    if (!id) { setLoadError('缺少创作编号'); return }
    const version = ++loadVersion.current
    setLoadError('')
    try {
      const [creation, tasks] = await Promise.all([getCreation(id), listRenders(id)])
      if (version !== loadVersion.current) return
      setDetail(creation)
      const sorted = [...tasks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      setRenders(sorted)
      const success = sorted.find((task) => task.status === 'SUCCESS')
      if (success) void showResult(success)
    } catch (error) {
      if (version === loadVersion.current) setLoadError((error as Error).message || '加载失败，请重试')
    }
  }, [id, showResult])

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

  useDidShow(() => {
    setVisible(true)
    void load()
    void loadCapabilities()
    void refreshMe().catch(() => setLoadError('账户刷新失败，请重试'))
  })
  useDidHide(() => {
    setVisible(false)
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

  useEffect(() => {
    if (!visible || !id || !pendingTask) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    // 轮询必须封顶：服务端 sweeper 正常时任务 30 分钟内一定收敛，但如果 sweeper 挂了 /
    // 任务卡在 sweeper 不认的状态里，客户端原实现会每 3 秒请求一次、永不停止 ——
    // 用户把页面留在后台就是一整晚的网络与电量消耗。超过上限就停下来并明确告知。
    const startedAt = Date.now()
    const POLL_MAX_MS = 30 * 60 * 1000
    setPollError('')
    const poll = async () => {
      try {
        const latest = await getRender(id, pendingTask.id)
        if (cancelled) return
        failures = 0
        setPollError('')
        setRenders((tasks) => tasks.map((task) => task.id === latest.id ? latest : task))
        if (!ACTIVE_STATUS.includes(latest.status)) {
          if (latest.status === 'SUCCESS') void showResult(latest)
          else setPollError(latest.errorMsg || '任务已结束，请查看任务状态与积分账户')
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
  }, [visible, id, pendingTask?.id, pollRetry, refreshMe, showResult])

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

  const resultUrl = async () => {
    if (!selectedResult?.resultKey) throw new Error('请先选择已完成成片')
    const result = await getResultPlayUrl(selectedResult.resultKey)
    if (!result.url) throw new Error('下载地址暂不可用，请重试')
    return result.url
  }
  const copyDownload = async () => {
    try { await Taro.setClipboardData({ data: await resultUrl() }) }
    catch (error) { setResultError((error as Error).message || '复制下载链接失败') }
  }
  const saveResult = async () => {
    if (saving) return
    setSaving(true)
    try {
      const file = await Taro.downloadFile({ url: await resultUrl() })
      if (file.statusCode !== 200) throw new Error('下载失败，请重试或复制下载链接')
      await Taro.saveVideoToPhotosAlbum({ filePath: file.tempFilePath })
      void Taro.showToast({ title: '已保存到相册', icon: 'success' })
    } catch {
      setResultError('保存失败，请检查相册权限或复制下载链接。重复下载不扣积分。')
    } finally { setSaving(false) }
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
    if (!id || !detail || submitLock.current || pendingTask) return
    if (!materialsReady) { setLoadError('请先补齐全部分镜素材'); return }
    // P0-5 纵深防御：UI 已把不可用档位标灰，但状态可能过期（例如页面停留期间服务端改了配置），
    // 这里再拦一道，并顺手刷新一次能力表，避免用户反复点到同一个拒绝。
    if (gradeIssues[grade]) {
      setLoadError(gradeIssues[grade] as string)
      void loadCapabilities()
      return
    }
    submitLock.current = true
    setSubmitting(true)
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
    } finally { submitLock.current = false; setSubmitting(false) }
  }

  if (!detail) return <View className='rcompose__tip'>{loadError || '加载中…'}{loadError && <Button onClick={() => void load()}>重新加载</Button>}</View>
  const cost = estimatePoints(detail.shots, grade)
  const previewedGrade = selectedResult
    ? GRADE_OPTIONS.find((option) => option.key === selectedResult.grade)?.title || selectedResult.grade
    : ''
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
   */
  const showingStill = materialsReady && !!stillCover && (draggingAxis !== null || colorDirty || previewing || !!previewError)
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
          <View className='rcompose__optionrow'><View><Text className='rcompose__optiontitle'>清理停顿</Text><Text className='rcompose__optiondesc'>交给 ChatCut 处理语音空白</Text></View><Switch checked={chatcut.removeSilence} onChange={(event) => setChatcut((value) => ({ ...value, removeSilence: event.detail.value }))} color='#e1251b' /></View>
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
              AI 档暂不支持整片调色：该档由外部剪辑通道直接出片，调色参数不会被应用。需要调色请改选「基础生成」。
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

      {/* ── 进行中的任务 ── */}
      {pendingTask && (
        <View className='rcompose__card'>
          <ProgressLine
            percent={pendingTask.progress}
            label={STATUS_LABEL[pendingTask.status] || pendingTask.status}
            hint={pendingTask.deadlineAt ? `预计交付 ${pendingTask.deadlineAt}` : '处理中，请保持页面打开'}
          />
        </View>
      )}
      {pollError && (
        <View className='ds-notice rcompose__notice'>
          <Text>{pollError}</Text>
          <Button size='mini' onClick={() => { setPollRetry((value) => value + 1); void load() }}>重新查询</Button>
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
                <Text className='rcompose__history-title'>
                  {GRADE_OPTIONS.find((option) => option.key === task.grade)?.title || task.grade}
                </Text>
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
                {task.finishAt || task.createdAt} · {task.status === 'SUCCESS' ? '结算' : '任务积分'} {task.beanCharged} 积分
              </Text>
              {task.errorMsg && <Text className='rcompose__history-err'>{task.errorMsg}</Text>}
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
            disabled={submitting || !!pendingTask || !materialsReady}
            onClick={() => void doRender('FULL')}
          >
            {pendingTask ? '任务处理中' : lastSuccess ? '重新生成' : '生成成片'}
          </Button>
        </View>
      </View>
    </View>
  )
}
