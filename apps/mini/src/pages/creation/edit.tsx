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
import { splitCopyParagraphs, copyTextParagraphs } from '../../utils/copy-text'
import { isNumericId } from '../../utils/route-id'
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

/**
 * 竖排选项列表：一行一个选项，右边跟一句小字说明，选中时**整条**飘红。
 *
 * 取代本页原来那排 `Segmented`（几个并排的窄格）。窄格的问题是：
 * ① 放不下说明 ⇒ 说明只能挪到控件下方单独占一行；② 那一行只显示「当前选中那个」的解释，
 * 想比较两个款式得来回点；③ 选中态只是窄格里的一个小色块，「整条被选中」无从体现。
 *
 * ★ 与 `components/segmented` 的分工（别顺手把那边也换掉）：
 *   那边留给「换一款 / 换版式」这类**紧凑切换**场景 —— 编辑页在已生成后是收起状态，
 *   点开只为快速替换，竖排 4 行会把整页撑高；本页是**初次选择**，需要把每条讲清楚。
 */
function OptionList({
  options,
  value,
  onChange,
}: {
  options: { value: string; label: string; desc: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <View className='cedit__opts'>
      {options.map((o) => {
        const on = o.value === value
        return (
          <View
            key={o.value}
            className={`cedit__opt ${on ? 'cedit__opt--on' : ''}`}
            hoverClass={on ? 'none' : 'cedit__opt--hover'}
            // 再点一次已选中的那条不做事：既没有语义，也会白发一次落库请求
            onClick={() => { if (!on) onChange(o.value) }}
          >
            <Text className='cedit__opt-label'>{o.label}</Text>
            <Text className='cedit__opt-desc'>{o.desc}</Text>
          </View>
        )
      })}
    </View>
  )
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
  /**
   * 菜品是**必选项**，默认落在第一个（下标 0，不再有「不指定」）。
   *
   * 门店下一条菜都没有时这里会取到 undefined —— 由 onCreate 的守卫给出明确提示，
   * 而不是把「没得选」伪装成「可以跳过」：一条没菜的文案喂给 AI，`{{dishname}}` 会是空串，
   * 生成出来的东西跟这家店没关系，用户还得到最后一步才发现。
   */
  const [dishIdx, setDishIdx] = useState(0)
  const [title, setTitle] = useState('')
  /**
   * 「你想拍什么风格？」——选填，最多 200 字。会作为**最高优先级**的要求同时喂给文案与分镜两个提示词。
   *
   * 提交时**空串不发送**（见 onCreate 的 `userIdea.trim() || undefined`）：
   * 库列是 nullable 的，若这里把 '' 也发出去，「没填」就会同时存在 null 和 '' 两种形态，
   * 后面凡是判断「用户有没有写过」的地方都得写两遍。
   */
  const [userIdea, setUserIdea] = useState('')
  const [copyLoading, setCopyLoading] = useState(false)
  const [boardLoading, setBoardLoading] = useState(false)
  // P0-7 再入锁：state 更新是异步的，而且 tdesign 组件的 loading 要经 native setData 下发，
  // 快速连点时有真实窗口两次点击都看到 loading=false。两次调用会各自 newRequestId()，
  // 服务端幂等是按 requestId 建的 → 幂等失效 → 两次 AI 调用 + 两笔扣积分。
  // 所以闸门必须是**同步**的 ref：先置位再发请求，不与渲染节奏赛跑。
  const copyLockRef = useRef(false)
  const boardLockRef = useRef(false)
  const createLockRef = useRef(false)
  const [creating, setCreating] = useState(false)
  /**
   * 页脚「?」的说明气泡是否展开。
   *
   * 纯本地开关，不落库、不需要跨页保持 —— 它收的是原来常驻在按钮下方的那句
   * 「选好门店、菜品和表达方向，文案与分镜会自动整理好」：属于**按需了解**的信息，
   * 常驻只会占掉按按钮前最后一眼的注意力，收到问号里更合适。
   */
  const [showHelp, setShowHelp] = useState(false)
  // ── 同款配方（来自优秀作品） ──
  const [workRecipe, setWorkRecipe] = useState<WorkRecipe | null>(null)
  const [workTitle, setWorkTitle] = useState('')
  const [workLoaded, setWorkLoaded] = useState(false)
  /**
   * 同款配方里的**分镜骨架**（滤掉全空条目，后台允许留空行）。
   *
   * 有值时「生成」会把骨架一起提交（服务端在创建的事务里落成初始分镜），并**跳过 AI 分镜**
   * —— 这是本次改动的要点：用户从「生成同款」进来，拿到的是这条作品已经拆好的镜头结构，
   * 可以直接去拍摄页，不用先买一次分镜。不满意再点「重新生成」走 AI，那条路会整批替换。
   *
   * 判据只用「有没有内容」而不是长度：后台录入时可能出现空行，
   * 只发给服务端有意义的条目（否则会给出一条条空白分镜）。
   */
  const recipeSkeleton = (workRecipe?.shotSkeleton ?? []).filter(
    (s) => !!(s.shotType || s.shotSize || s.line || s.visualReq || s.durationSuggest),
  )
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
  /**
   * 「创建即生成」这一步**失败了**（区别于成功、取消、关闭等待）。
   *
   * ★ 为什么必须用 ref：`finally` 里要立刻判断「要不要收掉悬浮窗」，
   *   而 setState 要等下一轮渲染才读得到。
   * ★ 为什么失败时不能收掉悬浮窗：一收掉，渲染条件 `autoRunning` 变 false，
   *   整页就切到编辑视图，露出「生成文案」「生成分镜」两个手动按钮 ——
   *   用户看到的就是「刚才那次点击没生效，还得我自己再点两次」。
   *   所以失败后悬浮窗留着，换成「哪一步没成 + 重试」。
   */
  const autoFailedRef = useRef(false)
  /** 失败原因（给悬浮窗文案用），null = 正常生成中 */
  const [autoError, setAutoError] = useState<string | null>(null)
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
  /**
   * 「已经生成过」之后，「文案款式」/「镜头复杂度」这两行默认收起（减少已完成作品的视觉噪音）。
   *
   * 这里记的是「用户主动点开了」，而不是「要不要隐藏」—— 前者只在用户点过之后才为 true，
   * 不会与 hasCopy / hasShots 的异步变化打架（生成成功后 detail 变了，收起状态自然回到默认）。
   */
  const [showTrackPicker, setShowTrackPicker] = useState(false)
  const [showComplexityPicker, setShowComplexityPicker] = useState(false)
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
    // 换店后菜品列表整体换掉，回到第一个（菜品必选，没有「不指定」可以退）
    setDishIdx(0)
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
    setDishIdx(0)
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
   *
   * ★ 失败**不再退出到编辑视图**：留在等待态、把失败的那一步和「重试」摆出来。
   *   原因见 `autoFailedRef` 的说明 —— 退出会让用户面对手动按钮，像是没自动生成。
   * ★ 重试是**续跑**：已生成过的步骤跳过，不重复扣积分。
   *   `skipCopy` 由调用方按本地 detail 传入；再叠加一次服务端读回的判据做双保险。
   *
   * ⚠ 每一步仍然各自 `newRequestId()`，**别「优化」成复用同一个 requestId**：
   *   服务端的幂等语义是「同 requestId 只能有一条流水」（`bean_ledger` 唯一索引），
   *   复用会撞上 `ScenePendingError` → 2006「任务进行中或上次失败，请换 requestId 重试」，
   *   或者在上一步 FAILED 时直接返回兜底模板而不再真的重试。这是服务端刻意的契约。
   */
  const runAuto = async (id: string, opts?: { skipCopy?: boolean; skipBoard?: boolean }) => {
    autoExitRef.current = 'stay'
    autoIdRef.current = id
    autoFailedRef.current = false
    setAutoError(null)
    setAutoRunning(true)
    /** 走到哪一步断的，用于给悬浮窗定位（'文案' / '分镜'） */
    let failing = ''
    let usedFallback = false
    try {
      // 判据取自**服务端**而不是本地 state：失败可能发生在本页重新进入之后，
      // 本地 detail 未必是最新的。读不到时按「需要生成」处理（缺一步总比漏一步好）。
      const needCopy = !opts?.skipCopy && !(await getCreation(id).catch(() => null))?.copyText
      if (needCopy) {
        failing = '文案'
        const cr = await generateCopy(id, newRequestId(), track)
        // 等待期间被「取消生成」：不再发起分镜请求。
        // 已经发出去的这一笔文案请求撤不回来（请求层没有 abort 能力），
        // 但它的结果会落库 —— 为它付的那笔积分不浪费，用户可从「创作」进入接着用。
        if (waitingExit() === 'cancel') return
        usedFallback = cr.isFallbackTemplate
      }
      // 分镜已经生成过时跳过（重试专用）：每次生成都是一笔真实扣费，
      // 跳转失败后重试不该再买一遍同样的分镜。
      if (!opts?.skipBoard) {
        failing = '分镜'
        const br = await generateStoryboard(id, newRequestId(), complexity)
        // 「关闭等待」：两步照常跑完落库（用户稍后从「创作」进入），只是不再自动跳拍摄页
        if (waitingExit() !== 'stay') return
        if (!br.parsed || br.shots.length === 0) {
          // 没有分镜就没法拍摄，停在本页让用户重试，避免落到一个空的拍摄列表
          throw new Error('分镜内容没解析出来')
        }
        usedFallback = usedFallback || br.isFallbackTemplate
      }
      // ★ 生成阶段到此结束，后面再出问题就不是「生成」的问题了。
      //   不清零的话跳转失败会被报成「分镜这一步没成功」，用户点重试就再买一次分镜
      //   —— 明明内容早就在库里（实测：同一条创作白扣了两笔分镜积分）。
      failing = ''
      if (usedFallback) {
        Taro.showToast({ title: 'AI 繁忙，部分内容用了兜底', icon: 'none' })
      }
      // 编号必须落到 URL 里：拿不到就不跳，否则会跳到 `?id=undefined`，
      // 合成页拿这个字符串当编号去查，只会得到一句「参数不合法」。
      if (!isNumericId(id)) throw new Error('编号丢失')
      Taro.navigateTo({ url: `/pages/creation/shots?id=${id}` })
    } catch {
      // 用户主动取消时的失败不必再报「生成中断」——那是他自己按掉的
      if (waitingExit() === 'stay') {
        autoFailedRef.current = true
        setAutoError(failing ? `${failing}这一步没成功` : '内容已生成，但没能打开拍摄页，请点重试')
      }
    } finally {
      // 成败都要把详情落回页面：一是失败时页面停在可重试的状态，
      // 二是重试时要能按 detail 判断哪一步已经完成了（跳过它，不重复扣积分）。
      // 只置 autoRunning=false 而不拉详情，detail 仍是 null，页面会卡在「加载中…」。
      // 「关闭等待」会先离开本页，此时再拉一次只是白发一个请求（setState 也不会生效）。
      if (mountedRef.current) {
        await loadDetail(id).catch(() => undefined)
        // ★ 失败时保留悬浮窗，见 autoFailedRef 的说明
        if (!autoFailedRef.current) setAutoRunning(false)
      }
    }
  }

  const onCreate = async () => {
    const sid = stores[storeIdx]?.id
    if (!sid) {
      Taro.showToast({ title: '请选择门店', icon: 'none' })
      return
    }
    /**
     * 菜品必选。取不到时按「列表还没回来 / 该门店真没菜」分别给话，
     * 但不能放过去 —— 那样 `{{dishname}}` 会渲染成空串（网关对未命中的变量静默填空），
     * AI 只能凭空写一条跟这家店无关的文案，用户要到拍摄页才发现白扣了积分。
     */
    const did = dishes[dishIdx]?.id
    if (!did) {
      Taro.showToast({
        title: dishes.length ? '请选择菜品' : '该门店还没有菜品，请先添加',
        icon: 'none',
      })
      return
    }
    // 一次点击 = 创建 + 生成文案 + 生成分镜（连续两笔扣积分），连点会重复创建并双扣
    if (createLockRef.current) return
    createLockRef.current = true
    setCreating(true)
    try {
      const c = await createCreation({
        storeId: sid,
        dishId: did,
        title: title || undefined,
        // 空串不发：库里「没填」只留 null 一种形态（见 userIdea state 的说明）。
        // 纯空格也算没填 —— 服务端 optionalText 同样会 trim，这里先收敛掉少发一个字段。
        userIdea: userIdea.trim() || undefined,
        track,
        complexity,
        // 同款的分镜骨架：服务端在创建的事务里一并落成分镜。
        // 空数组不发 —— 服务端对「没传」与「传了空数组」的处理一致，但少发一个字段更省事。
        ...(recipeSkeleton.length ? { shotSkeleton: recipeSkeleton } : {}),
      })
      setLocalId(c.id)
      // 创建即生成：款式已选定，直接出文案和分镜，然后进拍摄页。
      // ★ 带着骨架进来时**跳过 AI 分镜**（skipBoard）—— 分镜已经在了，再生成一次
      //   既会把预置内容整批替换掉，又是一笔真实的扣费。用户要换 AI 版就去页面上点「重新生成」。
      await runAuto(c.id, { skipBoard: recipeSkeleton.length > 0 })
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
   * 所以「已扣的积分换来的文案」不丢掉 —— 用户从「创作」进入仍能看到并用它。
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

  /**
   * 失败后原地重试：**只补跑没成功的那一步**。
   * 已生成过的步骤跳过 —— 文案那次调用是已经扣过积分的，重跑会再扣一次。
   * 本地 detail 就是判据（它由 finally 里的 loadDetail 落回来，是最新的）。
   */
  const onRetryAuto = () => {
    const id = autoIdRef.current
    if (!id) return
    // 两步各自判「已经成功过就别再买一次」：**失败重试绝不能重复扣积分**。
    // 分镜的判据取自库里是否已有分镜（detail 由 finally 里的 loadDetail 落回，是最新的）。
    // 少了 skipBoard 的后果实测过：分镜早已生成、只是跳转失败，用户点一次重试就再买一遍分镜。
    void runAuto(id, { skipCopy: !!detail?.copyText, skipBoard: !!detail?.shots?.length })
  }

  /**
   * 去拍摄页。**编号必须落进 URL**，拿不到就当场说清、绝不跳。
   *
   * 漏检的后果不是「跳过去报个错」这么轻：`?id=${undefined}` 会拼成字符串
   * `'undefined'`，拍摄页与合成页都把它当成真编号去请求，服务端回一句
   * 「参数不合法」—— 用户完全不知道该做什么（已实测复现）。
   */
  const navToShots = (targetId: string | undefined) => {
    if (!isNumericId(targetId)) {
      Taro.showToast({ title: '编号丢失，请回到「创作」重新进入', icon: 'none' })
      return
    }
    Taro.navigateTo({ url: `/pages/creation/shots?id=${targetId}` })
  }

  /**
   * 失败后「稍后再说」：只收起悬浮窗，落到编辑视图。
   * 创作已经建好了（文案通常也有了），用户想手改文案/换款式时从这里走。
   * ★ 与「关闭等待」不同：那个是放弃等待并离开本页，这个是留在本页继续编辑。
   */
  const onDismissGenerate = () => {
    autoExitRef.current = 'cancel'
    autoFailedRef.current = false
    setAutoError(null)
    setAutoRunning(false)
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
      // 刚按用户选的那一款生成完，选择器就该收回去（否则又变回「一直摆在那儿」）
      setShowTrackPicker(false)
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
      setShowComplexityPicker(false)
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
  // 只要还在「创建即生成」里（生成中，或生成失败等着重试），就**留在这个分支**：
  // 悬浮窗要盖在**用户刚刚填的这张表单**上，而不是把整页替换成编辑视图。
  //
  // ★ 判据是 `autoRunning`，不能再叠加 `&& !detail`。
  //   叠加之后：失败或超时那一刻 finally 把 detail 拉了回来 ⇒ 条件变假 ⇒
  //   整页立刻切到编辑视图，悬浮窗连同「重试」一起消失，用户面前只剩
  //   「生成文案」「生成分镜」两个手动按钮 —— 看起来就是「点了没反应、还得我自己点两次」。
  //   这正是不做叠加的原因：失败后要停在等待态让用户原地重试。
  if (!localId || autoRunning) {
    return (
      <View className='cedit'>
        <View className='cedit__bar'>
          <StoreSwitcher />
          <Text className='cedit__barhint'>创作归属该门店</Text>
        </View>

        <View className='cedit__new-head'>
          <Text className='cedit__new-kicker'>NEW PROJECT</Text>
          <Text className='cedit__new-title'>今天想为哪道菜拍一条？</Text>
          {/* 原来这里的副标题（「选好门店、菜品和表达方向，AI 会帮你…」）已挪到页脚做小字提醒。
              它说的是「接下来要做什么」，摆在标题下方会先于表单占掉一屏注意力；
              而且带「AI」的说法在这里是多余的 —— 按钮和页脚已经说清会发生什么。 */}
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
            {/* 必选：range 里不再有「不指定」这一项，所以下标与 dishes 一一对应，
                这里也就不再需要 `- 1` 换算（旧写法是「下标 -1 = 不指定」的约定）。 */}
            <Picker
              mode='selector'
              range={dishes.map((d) => d.name)}
              onChange={(e: { detail: { value: string | number } }) => setDishIdx(Number(e.detail.value))}
              disabled={!stores[storeIdx] || !dishes.length}
            >
              <View className='cedit__picker'>{dishes[dishIdx]?.name || '请选择菜品'}</View>
            </Picker>
          </View>
          <View className='cedit__field cedit__field--last'>
            <Text className='cedit__label'>标题</Text>
            <Input
              className='cedit__input'
              value={title}
              onInput={(e: { detail: { value: string } }) => setTitle(e.detail.value)}
              placeholder='选填，默认门店+菜品名'
              placeholderClass='cedit__ph'
            />
          </View>
        </View>

        {/* ── 你想拍什么风格？──
            这是用户唯一能自由表达的地方，也是提示词里权重最高的一段：
            服务端把它渲染进「用户对怎么拍的要求 · 本次最高优先级」那一行，
            并在写作要求里明确「与其它任何一条冲突时以用户为准」（文案与分镜两个场景都是）。
            所以这个框不是「补充信息」，它排在前面的门店/菜品之后、规格选项之前 ——
            先说你想要什么风格，再用下面的选项微调。
            ★ 原来标题下还有一行「写一句你的想法，会优先按它来写」——删掉了：
              标题已经把「这里填什么」说清，那行只是把同一件事又说一遍，白占一行高。 */}
        <View className='cedit__card'>
          <View className='cedit__sechead'>
            <Text className='cedit__sectitle'>你想拍什么风格？</Text>
            <Text className='cedit__optional'>选填</Text>
          </View>
          {/* ★ maxlength 必须显式写：小程序 textarea 默认只让输 140 字，与服务端的 200 上限对不上 */}
          <Textarea
            className='cedit__idea'
            value={userIdea}
            maxlength={200}
            placeholder='例如：接地气的老板口播风、烟火气十足；或深夜食堂的治愈感、慢镜头特写'
            placeholderClass='cedit__ph'
            onInput={(e: { detail: { value: string } }) => setUserIdea(e.detail.value)}
          />
          <Text className='cedit__count'>{userIdea.length}/200</Text>
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
                  ? recipeSkeleton.length
                    ? `已预填「${trackLabel}」+「${complexityLabel}」，并按同款预置 ${recipeSkeleton.length} 个分镜`
                    : `已预填「${trackLabel}」+「${complexityLabel}」，可自行调整`
                  : '配方读取失败，请手动选择文案款式与镜头复杂度'}
            </Text>
            {/* 预置分镜这件事必须说清**省了什么**：用户最怕的是白扣积分。
                所以这里不写「已预置」，而是直接写「这次不再生成分镜、少扣一笔」，
                并给出换 AI 版的出口（原话：「不满意再点重新生成走 AI，两条路都留着」）。 */}
            {workLoaded && recipeSkeleton.length > 0 && (
              <Text className='cedit__recipe-warn'>
                这次只生成文案，不再生成分镜（少扣一笔）。分镜可逐条改；想换 AI 版就点「重新生成」
              </Text>
            )}
          </View>
        )}

        {/* ── 规格：文案款式 + 镜头复杂度（原来两张卡，现合成一张）──
            拆开时是「标题 + 说明 + 一排控件」各来一套，看起来像两个互不相干的入口；
            但用户心智里这是同一件事 —— 这条片子要什么调性、拆几个镜头。
            合成一张、中间一条细线分断，两组各自保留标题行。
            ★ 选项本身已改成**竖排单列**（见 OptionList）：一行一个、右边带小字说明、选中整条飘红。
              原来那排并排窄格里放不下说明，说明只能落到控件下方单独占一行、而且只显示选中项的，
              于是整块看上去「像分类、下面没有东西」。说明进了每一行之后，那一行 `&__desc` 也就撤掉了
              —— 现在所有选项的解释同时可见，不用来回点着比。 */}
        <View className='cedit__card'>
          <View className='cedit__spec-head'>
            <Text className='cedit__spec-title'>文案款式</Text>
            {/* 原来的「决定 AI 写文案的侧重点」去掉了「AI」：同一页里只说一次「谁在写」就够了 */}
            <Text className='cedit__spec-note'>决定文案的侧重点</Text>
          </View>
          <OptionList options={COPY_TRACK_OPTIONS} value={track} onChange={onPickTrack} />

          {/* 细分隔线：两组选项直接贴在一起会糊成一整块，看不出这是两组独立选项 */}
          <View className='cedit__split' />

          <View className='cedit__spec-head'>
            <Text className='cedit__spec-title'>镜头复杂度</Text>
            <Text className='cedit__spec-note'>自动决定分镜数量</Text>
          </View>
          <OptionList options={COMPLEXITY_OPTIONS} value={complexity} onChange={onPickComplexity} />
        </View>

        <View className='ds-footer'>
          {/* 问号与主按钮**成组居中**。
              不再套 `ds-footer__row`：它那条 `.ds-footer__row .ds-btn--block { flex:1; width:auto }`
              是给「上一步 + 下一步」那种一窄一宽的排法用的，会把按钮撑满整行，
              而这一版要的是半宽按钮（见 scss 的 `&__submit`）。
              ★ 居中容器不能直接是 `<Button>` —— 小程序原生 button 自带一套样式，
                给它设 `display:flex` 会影响其内部渲染，所以外面必须再包一层 View。 */}
          <View className='cedit__footrow'>
            <View
              className={`cedit__help ${showHelp ? 'cedit__help--on' : ''}`}
              hoverClass='ds-hover'
              onClick={() => setShowHelp((v) => !v)}
            >
              ?
            </View>
            <Button
              className='ds-btn ds-btn--primary cedit__submit'
              hoverClass='ds-hover'
              loading={creating}
              disabled={creating || (!!workId && !workLoaded)}
              onClick={onCreate}
            >
              {creating ? '生成中…' : '生成'}
            </Button>
          </View>
          {/* 这一行**只在「读同款配方」的瞬时态出现**：它讲的是此刻正在发生什么，
              与「点了会发生什么」不同 —— 收进气泡里用户就看不到进度了，所以必须留在外面。
              非读取态整行不渲染，页脚自然回到「只有一行按钮」的高度。 */}
          {!!workId && !workLoaded && (
            <View className='ds-footer__note'>正在读取同款配方…</View>
          )}
          {/* 点「?」弹出来的说明。.ds-footer 是 position:fixed，所以这里 absolute + bottom:100%
              就浮在页脚上沿，不会把按钮往下推（展开/收起时页脚高度不变）。
              两行都是**按需了解**的信息：读一遍就不用再看第二遍，不配常驻抢按按钮前最后一眼的注意力。 */}
          {showHelp && (
            <View className='cedit__help-bubble'>
              <Text className='cedit__help-line'>
                选好门店、菜品和表达方向，文案与分镜会自动整理好
              </Text>
              <Text className='cedit__help-line'>生成后会消耗积分，失败全额返还</Text>
            </View>
          )}
        </View>

        {/* 生成中的悬浮窗：盖在「初始页面」之上，而不是把整页替换掉 ——
            用户看得见自己填的表单还在，只是被挡住。
            两个出口的语义见 onCancelGenerate / onBackgroundGenerate；
            失败态换成 onRetryAuto / onDismissGenerate（见 autoFailedRef 的说明）。 */}
        {autoRunning && (
          <View className='cedit__gen-mask' catchMove>
            <View className='cedit__gen-card'>
              {autoError ? (
                <>
                  <View className='cedit__gen-icon'>!</View>
                  <Text className='cedit__gen-title'>生成没有完成</Text>
                  <Text className='cedit__gen-sub'>
                    {autoError}。已经生成好的部分不会重复扣积分，点「重试」接着跑就行。
                  </Text>
                  <View className='cedit__gen-actions'>
                    <View
                      className='cedit__gen-btn cedit__gen-btn--ghost'
                      hoverClass='ds-hover'
                      onClick={onDismissGenerate}
                    >
                      稍后再说
                    </View>
                    <View
                      className='cedit__gen-btn cedit__gen-btn--primary'
                      hoverClass='ds-hover'
                      onClick={onRetryAuto}
                    >
                      重试
                    </View>
                  </View>
                </>
              ) : (
                <>
                  <View className='cedit__gen-spinner' />
                  <Text className='cedit__gen-title'>
                    {recipeSkeleton.length ? '正在生成文案…' : '正在生成文案与分镜…'}
                  </Text>
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
                </>
              )}
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
  // 口播文案的分段：库里存的是一整块**没有换行**的文本（提示词明确要求「不要分点」），
  // 所以只能在前端切段 —— 好处是存量作品也立刻生效。纯函数 + 守护断言见 utils/copy-text.ts。
  const copyParagraphs = splitCopyParagraphs(detail.copyText)
  // 这两行各管各的：有文案就收起「文案款式」，有分镜就收起「镜头复杂度」。
  // ⚠ 没生成时那一行必须留着 —— 否则用户没地方选，也就走不到「生成」这个动作。
  const trackPickerVisible = !hasCopy || showTrackPicker
  const complexityPickerVisible = !hasShots || showComplexityPicker

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
            {/* 已生成后这一行默认收起；要换款式时点这里展开，不用时完全不占视觉 */}
            {hasCopy && (
              <Text className='cedit__secmore' onClick={() => setShowTrackPicker((v) => !v)}>
                {showTrackPicker ? '收起' : '换一款'}
              </Text>
            )}
          </View>
        </View>

        {trackPickerVisible && (
          <>
            {/* 编辑页这两处仍是 `Segmented`（紧凑切换），只是套上本页的观感覆写
                `.cedit .cedit__seg`（白底描边 + 选中项实心品牌红）。
                没换成 OptionList 是有意的：这里通常已生成过文案，「换一款」是**快捷替换**，
                竖排 4 行会把这一屏撑高；初次选择才需要把每条讲清楚。 */}
            <Segmented
              className='cedit__seg'
              options={COPY_TRACK_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              value={track}
              onChange={onPickTrack}
            />
            <Text className='cedit__desc'>{COPY_TRACK_OPTIONS.find((o) => o.value === track)?.desc}</Text>
          </>
        )}

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
            {/* 一段一个块：段间距靠逐段加类名，**不用相邻兄弟选择器 `+`**
                （小程序 wxss 对 `+`/`~` 的支持不稳），也不依赖 pre-wrap 渲染空行。 */}
            <View className='cedit__copy'>
              {copyParagraphs.map((p, index) => (
                <Text
                  key={`copy-p-${index}`}
                  className={`cedit__copy-p ${index > 0 ? 'cedit__copy-p--gap' : ''}`}
                >
                  {p}
                </Text>
              ))}
            </View>
            <View className='cedit__acts'>
              <Button
                className='cedit__act cedit__act--ghost'
                size='mini'
                onClick={() => onCopyText(copyTextParagraphs(detail.copyText))}
              >
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
          <View className='cedit__secbadges'>
            {!!detail.complexityLabel && <Text className='ds-pill ds-pill--gray'>{detail.complexityLabel}</Text>}
            {/* 同「文案款式」那行：已生成就收起，要改版式再点开 */}
            {hasShots && (
              <Text className='cedit__secmore' onClick={() => setShowComplexityPicker((v) => !v)}>
                {showComplexityPicker ? '收起' : '换版式'}
              </Text>
            )}
          </View>
        </View>

        {complexityPickerVisible && (
          <>
            <Segmented
              className='cedit__seg'
              options={COMPLEXITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              value={complexity}
              onChange={onPickComplexity}
            />
            <Text className='cedit__desc'>{COMPLEXITY_OPTIONS.find((o) => o.value === complexity)?.desc}</Text>
          </>
        )}

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
          onClick={() => navToShots(localId)}
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
