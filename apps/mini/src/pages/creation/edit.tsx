import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, Button, Input, Textarea, Picker } from '@tarojs/components'
import Taro from '@tarojs/taro'
import {
  createCreation,
  getCreation,
  generateCopy,
  generateStoryboard,
  updateCreation,
  updateShotContent,
  COPY_TRACK_OPTIONS,
  COMPLEXITY_OPTIONS,
  type CreationDetail,
  type CopyTrack,
  type Complexity,
  type ShotItem,
} from '../../services/creation'
import { type StoreItem } from '../../services/store'
import { getWork, type WorkRecipe } from '../../services/work'
import { listDishes, type DishItem } from '../../services/dish'
import { useMerchantStore } from '../../store/merchant'
import StoreSwitcher from '../../components/store-switcher'
import Segmented from '../../components/segmented'
import Steps from '../../components/steps'
import './edit.scss'

function newRequestId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** 镜头分类（与镜头库 category 对齐） */
const SHOT_TYPES = ['开场', '口播', '特写', '原料', '制作', '环境', '试吃', '卖点', '收尾']
/** 景别 */
const SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写', '大特写']

/**
 * 三步流程条。
 * 文案与分镜不再拆成两个独立步骤 —— 用户选好款式/复杂度后一次生成，
 * 所以它们同属第 1 步「创作」，页面本身也是随时可回退的编辑页。
 */
const STEP_LABELS = ['创作', '素材', '成片']

interface ShotDraft {
  shotType: string
  shotSize: string
  durationSuggest: string
  line: string
  visualReq: string
}

/** 单条分镜的可复制文本 */
function shotToText(s: ShotItem) {
  const parts = [`分镜 ${s.seq}`]
  if (s.shotType) parts.push(`镜头：${s.shotType}`)
  if (s.shotSize) parts.push(`景别：${s.shotSize}`)
  if (s.durationSuggest) parts.push(`时长：${s.durationSuggest}s`)
  if (s.libraryShot?.name) parts.push(`手法：${s.libraryShot.name}`)
  const head = parts.join('｜')
  const body = [s.line ? `台词：${s.line}` : '', s.visualReq ? `画面：${s.visualReq}` : '']
    .filter(Boolean)
    .join('\n')
  return body ? `${head}\n${body}` : head
}

export default function CreationEdit() {
  const params = Taro.getCurrentInstance().router?.params ?? {}
  // 从「优秀作品」带过来的同款配方：workId 预填款式/复杂度，用户仍可改
  const workId = params.workId ?? ''
  const currentStoreId = useMerchantStore((s) => s.currentStoreId)
  const setStore = useMerchantStore((s) => s.setStore)
  const loadStores = useMerchantStore((s) => s.loadStores)
  const [localId, setLocalId] = useState<string | undefined>(params.id)
  const [detail, setDetail] = useState<CreationDetail | null>(null)
  const [stores, setStores] = useState<StoreItem[]>([])
  const [dishes, setDishes] = useState<DishItem[]>([])
  const [storeIdx, setStoreIdx] = useState(0)
  const [dishIdx, setDishIdx] = useState(-1)
  const [title, setTitle] = useState('')
  const [copyLoading, setCopyLoading] = useState(false)
  const [boardLoading, setBoardLoading] = useState(false)
  // P0-7 再入锁：state 更新是异步的，而且 tdesign 组件的 loading 要经 native setData 下发，
  // 快速连点时有真实窗口两次点击都看到 loading=false。两次调用会各自 newRequestId()，
  // 服务端幂等是按 requestId 建的 → 幂等失效 → 两次 AI 调用 + 两笔扣豆。
  // 所以闸门必须是**同步**的 ref：先置位再发请求，不与渲染节奏赛跑。
  const copyLockRef = useRef(false)
  const boardLockRef = useRef(false)
  const createLockRef = useRef(false)
  const [creating, setCreating] = useState(false)
  // ── 同款配方（来自优秀作品） ──
  const [workRecipe, setWorkRecipe] = useState<WorkRecipe | null>(null)
  const [workTitle, setWorkTitle] = useState('')
  const [workLoaded, setWorkLoaded] = useState(false)
  const [autoRunning, setAutoRunning] = useState(false)
  /**
   * 悬浮窗上的出口，用**同步 ref** 记录：
   * - 'stay'       正常等待，两步跑完后跳拍摄页
   * - 'cancel'     取消生成 —— 不再发起后续步骤，回包一律忽略
   * - 'background' 关闭等待 —— 两步照常跑完落库，但完成时不再自动跳转
   * 必须用 ref 而不是 state：点击发生在某个 await 的间隙里，setState 要等下一轮渲染才生效，
   * 而这里要求「点下去立刻对已经在等待的请求链生效」。
   */
  const autoExitRef = useRef<'stay' | 'cancel' | 'background'>('stay')
  /** 正在生成的创作 id：取消时要把它拉回来，否则 detail 仍为 null 会闪一下「加载中…」 */
  const autoIdRef = useRef('')
  /** 「关闭等待」会离开本页，卸载后不能再 setState / 再跳转 */
  const mountedRef = useRef(true)
  useEffect(
    () => () => {
      mountedRef.current = false
    },
    [],
  )

  // 文案四款 + 分镜复杂度（新建时先本地选，创建后落库）
  const [track, setTrack] = useState<CopyTrack>('TRAFFIC')
  const [complexity, setComplexity] = useState<Complexity>('COMPLEX')
  // 文案编辑态
  const [editingCopy, setEditingCopy] = useState(false)
  const [copyDraft, setCopyDraft] = useState('')
  // 分镜编辑态
  const [editingShot, setEditingShot] = useState<string | null>(null)
  const [shotDraft, setShotDraft] = useState<ShotDraft>({
    shotType: '',
    shotSize: '',
    durationSuggest: '',
    line: '',
    visualReq: '',
  })

  const loadDetail = useCallback(async (id: string) => {
    const d = await getCreation(id)
    setDetail(d)
    if (d.track === 'TRAFFIC' || d.track === 'INTRO' || d.track === 'QUALITY' || d.track === 'RECOMMEND') setTrack(d.track)
    if (d.complexity === 'SIMPLE' || d.complexity === 'COMPLEX' || d.complexity === 'FINE') setComplexity(d.complexity)
  }, [])

  /** 拉取同款配方：预填文案款式 / 镜头复杂度 / 标题，用户仍可自行改 */
  useEffect(() => {
    if (!workId) return
    let cancelled = false
    void (async () => {
      try {
        const w = await getWork(workId)
        if (cancelled) return
        const r = w.recipeJson ?? {}
        setWorkTitle(w.title)
        setWorkRecipe(r)
        if (r.track === 'TRAFFIC' || r.track === 'INTRO' || r.track === 'QUALITY' || r.track === 'RECOMMEND') setTrack(r.track)
        if (r.complexity === 'SIMPLE' || r.complexity === 'COMPLEX' || r.complexity === 'FINE') setComplexity(r.complexity)
        if (r.titleHint) setTitle(r.titleHint)
      } catch {
        if (!cancelled) {
          // 配方拉不到不阻断建创作，退回让用户手选
          setWorkRecipe(null)
          Taro.showToast({ title: '同款配方加载失败，可手动选择', icon: 'none' })
        }
      } finally {
        if (!cancelled) setWorkLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [workId])

  // 新建创作：门店默认取左上角当前门店（门店是最高层，创作跟随门店）
  useEffect(() => {
    if (localId) {
      loadDetail(localId)
      return
    }
    let cancelled = false
    void (async () => {
      const list = await loadStores().catch(() => [] as StoreItem[])
      if (cancelled) return
      setStores(list)
      const idx = Math.max(0, list.findIndex((s) => s.id === currentStoreId))
      setStoreIdx(idx)
      const sid = list[idx]?.id
      if (sid) listDishes(sid).then(setDishes).catch(() => undefined)
    })()
    return () => { cancelled = true }
  }, [localId, loadDetail])

  const onStoreChange = (e: { detail: { value: string | number } }) => {
    const idx = Number(e.detail.value)
    setStoreIdx(idx)
    setDishIdx(-1)
    const sid = stores[idx]?.id
    if (sid) {
      // 同步为全局当前门店，保证首页/菜品/人设上下文一致
      setStore(sid)
      listDishes(sid).then(setDishes).catch(() => undefined)
    }
  }

  // 从左上角切换器换店时，表单里的门店与菜品同步跟随
  useEffect(() => {
    if (localId || !stores.length) return
    const idx = stores.findIndex((s) => s.id === currentStoreId)
    if (idx < 0 || idx === storeIdx) return
    setStoreIdx(idx)
    setDishIdx(-1)
    listDishes(currentStoreId).then(setDishes).catch(() => undefined)
  }, [currentStoreId, stores])

  /**
   * 读「悬浮窗出口」标志。
   * 包一层函数是必须的：runAuto 开头刚把 autoExitRef.current 置成 'stay'，
   * TypeScript 的控制流分析会据此把它收窄成字面量 'stay'，
   * 于是后面 `=== 'cancel'` 被判成「两个类型没有交集」而报 TS2367。
   * 但 ref 恰恰是能在 await 期间被用户点击改掉的 —— 那个收窄在这里是错的。
   */
  const waitingExit = () => autoExitRef.current

  /**
   * 一次跑完「文案 → 分镜」，成功后直接进拍摄页
   * —— 用户选好款式就拿到成品，不必在中间页手动点两次生成。
   * 任一步失败都留在本页：本页就是编辑页，页内有「重新生成」可原地重试；
   * 生成失败会全额解冻预扣的豆，重试不会重复扣费。
   */
  const runAuto = async (id: string) => {
    autoExitRef.current = 'stay'
    autoIdRef.current = id
    setAutoRunning(true)
    try {
      const cr = await generateCopy(id, newRequestId(), track)
      // 等待期间被「取消生成」：不再发起分镜请求。
      // 已经发出去的这一笔文案请求撤不回来（请求层没有 abort 能力），
      // 但它的结果会落库 —— 为它付的那笔豆不浪费，用户可从「创作」进入接着用。
      if (waitingExit() === 'cancel') return
      const br = await generateStoryboard(id, newRequestId(), complexity)
      // 「关闭等待」：两步照常跑完落库（用户稍后从「创作」进入），只是不再自动跳拍摄页
      if (waitingExit() !== 'stay') return
      if (!br.parsed || br.shots.length === 0) {
        // 没有分镜就没法拍摄，停在本页让用户重试，避免落到一个空的拍摄列表
        Taro.showToast({ title: '分镜生成异常，请重新生成', icon: 'none' })
        return
      }
      if (cr.isFallbackTemplate || br.isFallbackTemplate) {
        Taro.showToast({ title: 'AI 繁忙，部分内容用了兜底', icon: 'none' })
      }
      Taro.navigateTo({ url: `/pages/creation/shots?id=${id}` })
    } catch {
      // 用户主动取消时的失败不必再报「生成中断」——那是他自己按掉的
      if (waitingExit() === 'stay') {
        Taro.showToast({ title: '生成中断，可在本页重新生成', icon: 'none' })
      }
    } finally {
      // 成败都要把详情落回页面：失败时本页要停在可重试的编辑态。
      // 只置 autoRunning=false 而不拉详情，detail 仍是 null，页面会卡在「加载中…」。
      // 「关闭等待」会先离开本页，此时再拉一次只是白发一个请求（setState 也不会生效）。
      if (mountedRef.current) {
        await loadDetail(id).catch(() => undefined)
        setAutoRunning(false)
      }
    }
  }

  const onCreate = async () => {
    const sid = stores[storeIdx]?.id
    if (!sid) {
      Taro.showToast({ title: '请选择门店', icon: 'none' })
      return
    }
    // 一次点击 = 创建 + 生成文案 + 生成分镜（连续两笔扣豆），连点会重复创建并双扣
    if (createLockRef.current) return
    createLockRef.current = true
    setCreating(true)
    try {
      const c = await createCreation({
        storeId: sid,
        dishId: dishIdx >= 0 ? dishes[dishIdx]?.id : undefined,
        title: title || undefined,
        track,
        complexity,
      })
      setLocalId(c.id)
      // 创建即生成：款式已选定，直接出文案和分镜，然后进拍摄页
      await runAuto(c.id)
    } catch {
      /* 错误已在 request 层 toast */
    } finally {
      createLockRef.current = false
      setCreating(false)
    }
  }

  /**
   * 取消生成：立刻停止等待，并且不再发起后续步骤。
   * 已经发出去的那一笔撤不回来（请求层没有 abort 能力），但它的结果会落库，
   * 所以「已扣的豆换来的文案」不丢掉 —— 用户从「创作」进入仍能看到并用它。
   */
  const onCancelGenerate = async () => {
    autoExitRef.current = 'cancel'
    Taro.showToast({ title: '已取消生成，已完成的文案会保留', icon: 'none' })
    // 先把详情拉回来再收悬浮窗：否则 detail 仍是 null，页面会闪一下「加载中…」
    if (autoIdRef.current) await loadDetail(autoIdRef.current).catch(() => undefined)
    if (mountedRef.current) setAutoRunning(false)
  }

  /** 关闭等待：生成继续在后台跑完并落库，本页离开，之后从「创作」再次进入 */
  const onBackgroundGenerate = () => {
    autoExitRef.current = 'background'
    Taro.showToast({ title: '已转入后台生成，可从「创作」再次进入', icon: 'none' })
    // 拿不到上一页（从分享/扫码直达）时兜到「创作」列表，不让用户卡在原地
    Taro.navigateBack({ fail: () => Taro.switchTab({ url: '/pages/creation/list' }) })
  }

  /** 选款式/复杂度：本地即时生效，并静默落库，避免下次进入丢失 */
  const onPickTrack = (v: string) => {
    const value = v as CopyTrack
    setTrack(value)
    if (localId) updateCreation(localId, { track: value }).catch(() => undefined)
  }
  const onPickComplexity = (v: string) => {
    const value = v as Complexity
    setComplexity(value)
    if (localId) updateCreation(localId, { complexity: value }).catch(() => undefined)
  }

  /** 生成 / 重新生成文案 */
  const onGenCopy = async () => {
    if (!localId) return
    if (copyLockRef.current) return // 连点防护（同步闸门，先于 setState 生效）
    copyLockRef.current = true
    setCopyLoading(true)
    try {
      const r = await generateCopy(localId, newRequestId(), track)
      setDetail((d) => (d ? { ...d, copyText: r.text, track: r.track, trackLabel: r.trackLabel } : d))
      setEditingCopy(false)
      Taro.showToast({ title: r.isFallbackTemplate ? 'AI 繁忙，已用兜底文案' : '文案已生成', icon: 'none' })
    } catch {
      /* 2001 / 2005 已 toast */
    } finally {
      copyLockRef.current = false
      setCopyLoading(false)
    }
  }

  const onEditCopy = () => {
    setCopyDraft(detail?.copyText ?? '')
    setEditingCopy(true)
  }

  const onSaveCopy = async () => {
    if (!localId) return
    try {
      const d = await updateCreation(localId, { copyText: copyDraft })
      setDetail((prev) => (prev ? { ...prev, copyText: d.copyText } : prev))
      setEditingCopy(false)
      Taro.showToast({ title: '已保存', icon: 'success' })
    } catch {
      /* 已 toast */
    }
  }

  const onCopyText = (text: string, label = '已复制') => {
    if (!text) {
      Taro.showToast({ title: '暂无可复制内容', icon: 'none' })
      return
    }
    Taro.setClipboardData({ data: text })
      .then(() => Taro.showToast({ title: label, icon: 'none' }))
      .catch(() => undefined)
  }

  /** 生成 / 重新生成分镜 */
  const onGenBoard = async () => {
    if (!localId) return
    if (boardLockRef.current) return // 连点防护（同步闸门，见 copyLockRef 说明）
    boardLockRef.current = true
    setBoardLoading(true)
    try {
      const r = await generateStoryboard(localId, newRequestId(), complexity)
      if (!r.parsed) {
        Taro.showToast({ title: '分镜解析异常，请重试', icon: 'none' })
        await loadDetail(localId)
        return
      }
      await loadDetail(localId)
      Taro.showToast({
        title: r.isFallbackTemplate ? `AI 繁忙，已用兜底分镜（${r.shots.length}）` : `已生成 ${r.shots.length} 个分镜`,
        icon: 'none',
      })
    } catch {
      /* 错误已 toast */
    } finally {
      boardLockRef.current = false
      setBoardLoading(false)
    }
  }

  const onStartEditShot = (s: ShotItem) => {
    setEditingShot(s.id)
    setShotDraft({
      shotType: s.shotType ?? '',
      shotSize: s.shotSize ?? '',
      durationSuggest: s.durationSuggest ? String(s.durationSuggest) : '',
      line: s.line ?? '',
      visualReq: s.visualReq ?? '',
    })
  }

  const onSaveShot = async (shotId: string) => {
    if (!localId) return
    try {
      const dur = Number(shotDraft.durationSuggest)
      await updateShotContent(localId, shotId, {
        shotType: shotDraft.shotType || null,
        shotSize: shotDraft.shotSize || null,
        durationSuggest: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : null,
        line: shotDraft.line,
        visualReq: shotDraft.visualReq,
      })
      setEditingShot(null)
      await loadDetail(localId)
      Taro.showToast({ title: '分镜已保存', icon: 'success' })
    } catch {
      /* 已 toast */
    }
  }

  // 同款配方的可读文案（预填提示与详情页保持同一套字典）
  const trackLabel = COPY_TRACK_OPTIONS.find((o) => o.value === track)?.label ?? ''
  const complexityLabel = COMPLEXITY_OPTIONS.find((o) => o.value === complexity)?.label ?? ''

  // ───────────── 新建创作（未落库前） ─────────────
  // 生成中（autoRunning）而详情还没落回来时也留在这个分支：
  // 悬浮窗要盖在**用户刚刚填的这张表单**上，而不是把整页替换成等待页。
  if (!localId || (autoRunning && !detail)) {
    return (
      <View className='cedit'>
        <View className='cedit__bar'>
          <StoreSwitcher />
          <Text className='cedit__barhint'>创作归属该门店</Text>
        </View>

        <View className='cedit__new-head'>
          <Text className='cedit__new-kicker'>NEW PROJECT</Text>
          <Text className='cedit__new-title'>今天想为哪道菜拍一条？</Text>
          <Text className='cedit__new-desc'>选好门店、菜品和表达方向，AI 会帮你把想法整理成文案与分镜。</Text>
        </View>

        <View className='cedit__card'>
          <View className='cedit__field'>
            <Text className='cedit__label'>门店</Text>
            <Picker mode='selector' range={stores.map((s) => s.name)} onChange={onStoreChange}>
              <View className='cedit__picker'>{stores[storeIdx]?.name || '请选择门店'}</View>
            </Picker>
          </View>
          <View className='cedit__field'>
            <Text className='cedit__label'>菜品</Text>
            <Picker
              mode='selector'
              range={['不指定', ...dishes.map((d) => d.name)]}
              onChange={(e: { detail: { value: string | number } }) => setDishIdx(Number(e.detail.value) - 1)}
              disabled={!stores[storeIdx]}
            >
              <View className='cedit__picker'>{dishIdx >= 0 ? dishes[dishIdx]?.name : '不指定（可选）'}</View>
            </Picker>
          </View>
          <View className='cedit__field cedit__field--last'>
            <Text className='cedit__label'>标题</Text>
            <Input
              className='cedit__input'
              value={title}
              onInput={(e: { detail: { value: string } }) => setTitle(e.detail.value)}
              placeholder='选填，留空用门店+菜品名'
              placeholderClass='cedit__ph'
            />
          </View>
        </View>

        {/* 来自「优秀作品」的同款配方：只预填，不替用户做决定 */}
        {!!workId && (
          <View className='cedit__recipe'>
            <View className='cedit__recipe-head'>
              <Text className='cedit__recipe-badge'>同款配方</Text>
              <Text className='cedit__recipe-title'>{workTitle || '优秀作品'}</Text>
            </View>
            <Text className='cedit__recipe-desc'>
              {!workLoaded
                ? '正在读取配方…'
                : workRecipe
                  ? `已预填「${trackLabel}」+「${complexityLabel}」，可自行调整`
                  : '配方读取失败，请手动选择文案款式与镜头复杂度'}
            </Text>
          </View>
        )}

        <View className='cedit__card'>
          <Text className='cedit__sectitle'>文案款式</Text>
          <Text className='cedit__hint'>决定 AI 写文案的侧重点</Text>
          <Segmented
            options={COPY_TRACK_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            value={track}
            onChange={onPickTrack}
          />
          <Text className='cedit__desc'>{COPY_TRACK_OPTIONS.find((o) => o.value === track)?.desc}</Text>
        </View>

        <View className='cedit__card'>
          <Text className='cedit__sectitle'>镜头复杂度</Text>
          <Text className='cedit__hint'>自动决定分镜数量</Text>
          <Segmented
            options={COMPLEXITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            value={complexity}
            onChange={onPickComplexity}
          />
          <Text className='cedit__desc'>{COMPLEXITY_OPTIONS.find((o) => o.value === complexity)?.desc}</Text>
        </View>

        <View className='ds-footer'>
          <Button
            className='ds-btn ds-btn--primary ds-btn--block'
            hoverClass='ds-hover'
            loading={creating}
            disabled={creating || (!!workId && !workLoaded)}
            onClick={onCreate}
          >
            {creating ? '生成中…' : '生成文案与分镜'}
          </Button>
          <View className='ds-footer__note'>
            {!!workId && !workLoaded ? '正在读取同款配方…' : '生成后会消耗 AI 豆，失败全额返还'}
          </View>
        </View>

        {/* 生成中的悬浮窗：盖在「初始页面」之上，而不是把整页替换掉 ——
            用户看得见自己填的表单还在，只是被挡住。
            两个出口的语义见 onCancelGenerate / onBackgroundGenerate。 */}
        {autoRunning && (
          <View className='cedit__gen-mask' catchMove>
            <View className='cedit__gen-card'>
              <View className='cedit__gen-spinner' />
              <Text className='cedit__gen-title'>正在生成文案与分镜…</Text>
              <Text className='cedit__gen-sub'>
                关闭等待后仍会继续生成，可稍后从「创作」再次进入
              </Text>
              <View className='cedit__gen-actions'>
                <View
                  className='cedit__gen-btn cedit__gen-btn--ghost'
                  hoverClass='ds-hover'
                  onClick={() => void onCancelGenerate()}
                >
                  取消生成
                </View>
                <View
                  className='cedit__gen-btn cedit__gen-btn--primary'
                  hoverClass='ds-hover'
                  onClick={onBackgroundGenerate}
                >
                  关闭等待
                </View>
              </View>
            </View>
          </View>
        )}
      </View>
    )
  }

  if (!detail) return <View className='cedit__tip'>加载中…</View>

  const hasCopy = !!detail.copyText
  const hasShots = detail.shots.length > 0
  // 文案与分镜同属第 1 步「创作」；两者都齐时流程条推进到第 2 步「素材」，提示可以往下走
  const step = hasCopy && hasShots ? 1 : 0

  return (
    <View className='cedit'>
      <View className='cedit__steps-wrap'>
        <Steps steps={STEP_LABELS} current={step} />
        <View className='cedit__stage'>
          <Text className='cedit__stage-kicker'>STEP 1 OF 3 · CREATE</Text>
          <Text className='cedit__stage-title'>{step === 0 ? '先把文案和分镜准备好' : '文案和分镜已就绪，去拍摄吧'}</Text>
        </View>
      </View>

      <View className='cedit__head'>
        <Text className='cedit__htitle'>{detail.title || '未命名创作'}</Text>
        <Text className='cedit__hstore'>{detail.store?.name}</Text>
      </View>

      {/* ───────────── 口播文案：流量款 / 介绍款 / 质量款 ───────────── */}
      <View className='cedit__card'>
        <View className='cedit__secbar'>
          <Text className='cedit__sectitle'>口播文案</Text>
          <View className='cedit__secbadges'>
            {!!detail.trackLabel && <Text className='ds-pill ds-pill--red-soft'>{detail.trackLabel}</Text>}
            {hasCopy && <Text className='ds-pill ds-pill--ghost'>已生成 · {(detail.copyText ?? '').length} 字</Text>}
          </View>
        </View>

        <Segmented
          options={COPY_TRACK_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={track}
          onChange={onPickTrack}
        />
        <Text className='cedit__desc'>{COPY_TRACK_OPTIONS.find((o) => o.value === track)?.desc}</Text>

        {editingCopy ? (
          <View className='cedit__editbox'>
            <Textarea
              className='cedit__textarea'
              value={copyDraft}
              maxlength={-1}
              autoHeight
              onInput={(e: { detail: { value: string } }) => setCopyDraft(e.detail.value)}
              placeholder='编辑文案…'
              placeholderClass='cedit__ph'
            />
            <View className='cedit__acts'>
              <Button className='cedit__act cedit__act--ghost' size='mini' onClick={() => setEditingCopy(false)}>
                取消
              </Button>
              <Button className='cedit__act cedit__act--main' size='mini' onClick={onSaveCopy}>
                保存
              </Button>
            </View>
          </View>
        ) : hasCopy ? (
          <>
            <View className='cedit__copy'>{detail.copyText}</View>
            <View className='cedit__acts'>
              <Button className='cedit__act cedit__act--ghost' size='mini' onClick={() => onCopyText(detail.copyText ?? '')}>
                复制
              </Button>
              <Button className='cedit__act cedit__act--ghost' size='mini' onClick={onEditCopy}>
                编辑
              </Button>
              <Button
                className='cedit__act cedit__act--main'
                size='mini'
                loading={copyLoading}
                disabled={copyLoading}
                onClick={onGenCopy}
              >
                重新生成
              </Button>
            </View>
          </>
        ) : (
          <>
            <View className='cedit__empty'>选好款式后点击下方按钮生成文案</View>
            <View className='cedit__acts'>
              <Button
                className='cedit__act cedit__act--main'
                size='mini'
                loading={copyLoading}
                disabled={copyLoading}
                onClick={onGenCopy}
              >
                生成文案
              </Button>
            </View>
          </>
        )}
      </View>

      {/* ───────────── 分镜脚本：复杂度 → 2~9 镜，可复制/编辑/重新生成 ───────────── */}
      <View className='cedit__card'>
        <View className='cedit__secbar'>
          <Text className='cedit__sectitle'>分镜脚本（{detail.shots.length}）</Text>
          {!!detail.complexityLabel && <Text className='ds-pill ds-pill--gray'>{detail.complexityLabel}</Text>}
        </View>

        <Segmented
          options={COMPLEXITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={complexity}
          onChange={onPickComplexity}
        />
        <Text className='cedit__desc'>{COMPLEXITY_OPTIONS.find((o) => o.value === complexity)?.desc}</Text>

        <View className='cedit__genbox'>
          <Button
            className='cedit__act cedit__act--main'
            size='mini'
            loading={boardLoading}
            disabled={boardLoading}
            onClick={onGenBoard}
          >
            {detail.shots.length > 0 ? '重新生成' : '生成分镜'}
          </Button>
          {detail.shots.length > 0 && (
            <Button
              className='cedit__act cedit__act--ghost'
              size='mini'
              onClick={() => onCopyText(detail.shots.map(shotToText).join('\n\n'), '分镜已复制')}
            >
              一键复制
            </Button>
          )}
        </View>

        {detail.shots.length === 0 && <View className='cedit__empty'>尚未生成分镜</View>}

        {detail.shots.map((s) => (
          <View className='cedit__shot' key={s.id}>
            <View className='cedit__shothead'>
              <Text className='cedit__shotseq'>{s.seq}</Text>
              <View className='cedit__shotmeta'>
                <Text className='cedit__shottype'>{s.shotType || '未分类'}</Text>
                {!!s.shotSize && <Text className='cedit__chip'>{s.shotSize}</Text>}
                {!!s.durationSuggest && <Text className='cedit__chip'>{s.durationSuggest}s</Text>}
              </View>
              <View className='cedit__shotacts'>
                <Text className='cedit__link' onClick={() => onCopyText(shotToText(s), '已复制该分镜')}>
                  复制
                </Text>
                <Text
                  className='cedit__link'
                  onClick={() => (editingShot === s.id ? setEditingShot(null) : onStartEditShot(s))}
                >
                  {editingShot === s.id ? '收起' : '编辑'}
                </Text>
              </View>
            </View>

            {editingShot === s.id ? (
              <View className='cedit__shotedit'>
                <View className='cedit__row'>
                  <Text className='cedit__rowlabel'>镜头</Text>
                  <Picker
                    mode='selector'
                    range={SHOT_TYPES}
                    onChange={(e: { detail: { value: string | number } }) =>
                      setShotDraft((d) => ({ ...d, shotType: SHOT_TYPES[Number(e.detail.value)] ?? '' }))
                    }
                  >
                    <View className='cedit__rowvalue'>{shotDraft.shotType || '请选择'}</View>
                  </Picker>
                </View>
                <View className='cedit__row'>
                  <Text className='cedit__rowlabel'>景别</Text>
                  <Picker
                    mode='selector'
                    range={SHOT_SIZES}
                    onChange={(e: { detail: { value: string | number } }) =>
                      setShotDraft((d) => ({ ...d, shotSize: SHOT_SIZES[Number(e.detail.value)] ?? '' }))
                    }
                  >
                    <View className='cedit__rowvalue'>{shotDraft.shotSize || '请选择'}</View>
                  </Picker>
                </View>
                <View className='cedit__row'>
                  <Text className='cedit__rowlabel'>时长(s)</Text>
                  <Input
                    className='cedit__rowinput'
                    type='number'
                    value={shotDraft.durationSuggest}
                    onInput={(e: { detail: { value: string } }) =>
                      setShotDraft((d) => ({ ...d, durationSuggest: e.detail.value }))
                    }
                    placeholder='如 4'
                    placeholderClass='cedit__ph'
                  />
                </View>
                <Textarea
                  className='cedit__textarea'
                  value={shotDraft.line}
                  maxlength={-1}
                  autoHeight
                  onInput={(e: { detail: { value: string } }) => setShotDraft((d) => ({ ...d, line: e.detail.value }))}
                  placeholder='台词片段'
                  placeholderClass='cedit__ph'
                />
                <Textarea
                  className='cedit__textarea'
                  value={shotDraft.visualReq}
                  maxlength={-1}
                  autoHeight
                  onInput={(e: { detail: { value: string } }) => setShotDraft((d) => ({ ...d, visualReq: e.detail.value }))}
                  placeholder='画面要求'
                  placeholderClass='cedit__ph'
                />
                <View className='cedit__acts'>
                  <Button className='cedit__act cedit__act--ghost' size='mini' onClick={() => setEditingShot(null)}>
                    取消
                  </Button>
                  <Button className='cedit__act cedit__act--main' size='mini' onClick={() => onSaveShot(s.id)}>
                    保存
                  </Button>
                </View>
              </View>
            ) : (
              <View className='cedit__shotbody'>
                <Text className='cedit__shotline'>{s.line || '—'}</Text>
                {!!s.visualReq && <Text className='cedit__shotvisual'>画面：{s.visualReq}</Text>}
                {!!s.libraryShot?.name && <Text className='cedit__shotlib'>手法：{s.libraryShot.name}</Text>}
              </View>
            )}
          </View>
        ))}
      </View>

      <View className='ds-footer'>
        <Button
          className={`ds-btn ds-btn--primary ds-btn--block ${hasShots ? '' : 'ds-btn--disabled'}`}
          hoverClass='ds-hover'
          disabled={!hasShots}
          onClick={() => Taro.navigateTo({ url: `/pages/creation/shots?id=${localId}` })}
        >
          下一步
        </Button>
        <View className='ds-footer__note'>
          {hasShots ? '按分镜逐条拍摄并上传素材' : '先生成分镜，才能进入拍摄'}
        </View>
      </View>
    </View>
  )
}
