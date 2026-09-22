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
  DISH_TRACK_OPTIONS,
  DEFAULT_DISH_TRACK,
  COMPLEXITY_OPTIONS,
  toDishTrack,
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
import { isNumericId, readRouteId, isBrokenRouteId } from '../../utils/route-id'
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
  const params = Taro.getCurrentInstance().router?.params as Record<string, unknown> | undefined
  /**
   * 从「优秀作品」带过来的同款配方：workId 预填款式/复杂度，用户仍可改。
   * ★ 同样要过 `readRouteId`：`?workId=undefined` 会让 getWork('undefined') 吃一个 4000，
   *   而这个错误被 catch 吞掉后表现为「同款配方区一直不出现」—— 用户看不出是链接坏了。
   */
  const workId = readRouteId(params, 'workId') ?? ''
  const currentStoreId = useMerchantStore((s) => s.currentStoreId)
  // ⚠ 这里**不再**取 `setStore`：门店的唯一入口是左上角的 StoreSwitcher（2026-09-21）。
  //   表单里那个「门店」下拉已删掉 —— 同一页两个门店选择器，用户会以为是两件事。
  const loadStores = useMerchantStore((s) => s.loadStores)
  /**
   * 本页的创作编号。
   * ★ **入口**也要校验，不能只校验出口：这个 id 会被原样拿去 `getCreation(id)` /
   *   `updateCreation(id, …)` / `generateCopy(id, …)`，而 `?id=undefined` 拼出来的 URL
   *   看起来完全正常 —— 页面照常渲染，用户一路填表、点「生成」，最后拿到的只是一句
   *   「参数不合法」，既不知道该点哪里，也不知道是哪一步错的。
   */
  const [localId, setLocalId] = useState<string | undefined>(readRouteId(params) ?? undefined)
  /**
   * 路由里带了编号、但这个编号不合法。
   * ★ 不能把它当成「新建」放过去（也就是不能只写 `readRouteId(...) ?? undefined`）：
   *   那样用户以为在编辑一条已有创作，实际提交时 `createCreation` 会**新建出第二条**，
   *   而原来那条还在，白扣一次积分。所以坏编号必须当场拦下来，而不是退化成另一种合法语义。
   */
  const idBroken = isBrokenRouteId(params)
  const [detail, setDetail] = useState<CreationDetail | null>(null)
  const [stores, setStores] = useState<StoreItem[]>([])
  const [dishes, setDishes] = useState<DishItem[]>([])
  /**
   * 当前 `dishes` 属于哪家门店。
   *
   * ★ 为什么不只看 `dishes.length`：门店切换 / 全局门店同步 / 首次加载三条路径
   *   都会异步 `listDishes(...).then(setDishes)`，而它们**没有顺序保证**。
   *   A 店的慢响应落在 B 店的快响应之后，界面就会显示 B 店的店名配 A 店的菜品；
   *   用户选中后提交，`{{dishname}}` 填的是 A 店的菜 —— AI 写出一条跟当前门店无关的文案，
   *   用户要到拍摄页才发现白扣了积分。
   *   两件事一起做才有效：① 只接受最新一次请求的响应（dishReqRef）；
   *   ② 创建前校验「菜品列表确实是当前门店的」（dishesStoreId）。
   *   只做 ① 挡不住「请求发出后门店又变了」，只做 ② 挡不住「响应乱序后列表整片替换」。
   */
  const [dishesStoreId, setDishesStoreId] = useState('')
  /**
   * 菜品列表是否**加载失败**（网络/接口错误），与「这家店真的没有菜品」是两回事。
   * ★ 旧实现把失败直接吞成空数组，页面于是显示「该门店还没有菜品」，并把提交按钮的
   *   校验话术也说成「请先添加」——用户会去建菜，而实际上他早就建过了。
   *   失败必须能被区分出来，并给一个原地重试的出口。
   */
  const [dishesFailed, setDishesFailed] = useState(false)
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
  const [copyLoading, setCopyLoading] = useState(false)
  const [boardLoading, setBoardLoading] = useState(false)
  // P0-7 再入锁：state 更新是异步的，而且 tdesign 组件的 loading 要经 native setData 下发，
  // 快速连点时有真实窗口两次点击都看到 loading=false。两次调用会各自 newRequestId()，
  // 服务端幂等是按 requestId 建的 → 幂等失效 → 两次 AI 调用 + 两笔扣积分。
  // 所以闸门必须是**同步**的 ref：先置位再发请求，不与渲染节奏赛跑。
  const copyLockRef = useRef(false)
  const boardLockRef = useRef(false)
  const createLockRef = useRef(false)
  /**
   * 菜品请求代次。每次发起 `listDishes` 自增，回包只认「自己是最后一次」的那次。
   * 与 `dishesStoreId` 配合使用（见它的说明）。
   */
  const dishReqRef = useRef(0)

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

  // 菜品稿三款 + 分镜复杂度（新建时先本地选，创建后落库）。
  // ★ 默认款式取常量，不再写字面量：2026-09-21 四款改型时这里写的是 'INTRO'（介绍款），
  //   而 'INTRO' 已经不存在于 CopyTrack 里了。写死一个款式名，改型时**必然漏改这一处**，
  //   而漏改的表现是「选择器一项都不选中」——不报错、只是看着像没选款式。
  //   这里的默认值同时要和**服务端**的 DEFAULT_COPY_TRACK 一致，
  //   否则「没选款式」时前端显示一款、实际生成的是另一款。
  const [track, setTrack] = useState<CopyTrack>(DEFAULT_DISH_TRACK)
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
    // toDishTrack：存量创作里可能有 track='TRAFFIC'（25 条）或 'NORMAL'（20 条），
    // 这两个值都不在选择器里 —— 直接 setTrack 会让选择器一项都不选中。收敛成三款，不是就保持默认。
    const t = toDishTrack(d.track)
    if (t) setTrack(t)
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
        // 同 toDishTrack：优秀作品的配方里可能带「流量款」（那是独立功能了），
        // 带进来会让选择器空着 —— 收敛成菜品稿三款。
        const rt = toDishTrack(r.track)
        if (rt) setTrack(rt)
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

  /**
   * 拉取某门店的菜品，并且**只接受最新一次请求的响应**。
   *
   * 切换门店 / 左上角换店 / 首次进入三条路径都走这里：老实现各自
   * `listDishes(sid).then(setDishes)`，谁先回来谁生效 —— 慢的那次（旧门店）
   * 后到就会把新门店的菜品整片覆盖掉。见 `dishesStoreId` 的说明。
   */
  const loadDishesFor = (sid: string) => {
    const my = ++dishReqRef.current
    // 立刻清空并把「当前菜品归属」置空：在响应回来之前，界面上不能还留着上一家店的菜，
    // 否则用户在这几百毫秒里点提交，提交的就是别家店的菜品
    setDishes([])
    setDishIdx(0)
    setDishesStoreId('')
    setDishesFailed(false)
    listDishes(sid)
      .then((list) => {
        if (my !== dishReqRef.current) return
        setDishes(list)
        setDishesStoreId(sid)
      })
      .catch(() => {
        if (my !== dishReqRef.current) return
        // 失败保持空列表 + 空的归属标记：宁可让用户看到「还没有菜品」也不显示错店的菜
        setDishes([])
        setDishesStoreId('')
        setDishesFailed(true)
      })
  }

  // ── 店铺/菜品加载 ────────────────────────────────────────────────
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
      if (sid) loadDishesFor(sid)
    })()
    return () => { cancelled = true }
  }, [localId, loadDetail])

  // ★ 表单里原来的「门店」下拉已删（2026-09-21）：它和左上角 StoreSwitcher 是同一件事，
  //   而且两个选择器会各写一次全局门店，谁覆盖谁取决于点的顺序 —— 用户只会觉得「换了一家没生效」。
  //   现在门店**只能**从 StoreSwitcher 换，本页的 storeIdx / 菜品列表跟着 currentStoreId 走
  //   （下面那个 useEffect）。所以这里不需要 onStoreChange 了。

  // 从左上角切换器换店时，表单里的门店与菜品同步跟随
  useEffect(() => {
    if (localId || !stores.length) return
    const idx = stores.findIndex((s) => s.id === currentStoreId)
    if (idx < 0 || idx === storeIdx) return
    setStoreIdx(idx)
    setDishIdx(0)
    if (currentStoreId) loadDishesFor(currentStoreId)
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
      // ★ 文案要指到**唯一**能选门店的地方（本页已没有门店选择器）：
      //   原来写「请选择门店」，而页面上根本没有那个控件了，用户只会原地找不到北。
      Taro.showToast({ title: '请先在左上角选择门店', icon: 'none' })
      return
    }
    /**
     * ★ 菜品必须**确认属于当前门店**才允许提交。
     *
     * `dishes` 是异步来的，可能还是上一家店的（切换门店的响应还没回来 / 乱序回包）。
     * 只看 `dishes[dishIdx]` 有没有值是不够的：它可能是别家店的菜，而
     * `{{dishname}}` 会被填成那道菜，AI 于是写出一条与当前门店无关的文案 ——
     * 用户要到拍摄页才发现白扣了积分。所以这里比对归属标记。
     */
    if (dishesStoreId !== sid) {
      Taro.showToast({
        title: dishesFailed ? '菜品列表加载失败，请点「菜品」重试' : '菜品还在加载，请稍候再试',
        icon: 'none',
      })
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
   * 流量款入口：跳到独立的「话题稿」页。
   * ★ 它是**另一条链路**（不选门店、不选菜品），所以不是在本页切个款式的开关，而是换页面。
   *   把话题稿塞进本页当第四款，用户会以为还得先选菜 —— 那正是要拆掉的东西。
   */
  const onOpenTraffic = () => Taro.navigateTo({ url: '/pages/creation/traffic' })

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

  /**
   * 菜品 / 套餐在列表里的显示文案。
   * ★ 必须带上类型前缀：套餐与单菜**共用同一个 Picker**（服务端也是同一张表、同一个接口），
   *   而套餐名往往就叫「双人套餐」「四人餐」—— 不标类型时用户看到一行「双人套餐」，
   *   既不知道它是一条独立记录还是某道菜，也无从判断 AI 会拿它做什么。
   *   选中之后 `{{dishName}}` 拿到的其实完全一样（都是这条记录的 name），
   *   但「我知道我选了什么」这件事本身是必须给的。
   */
  const dishLabel = (d: DishItem) => (d.kind === 'COMBO' ? `【套餐】${d.name}` : d.name)

  /**
   * 菜品选择器上显示什么。
   * ★ 这四种状态必须在界面上长得**不一样**：「加载中」「加载失败」「这家店真没菜」
   *   在旧实现里全都渲染成空白，用户只能得到「点不动、也不知道为什么」。
   */
  const dishPickerText = (() => {
    const cur = stores[storeIdx]
    // 门店选择器已不在本页 ⇒ 这一句必须说清**去哪儿选**，否则用户在这一屏找不到入口
    if (!cur) return '请先在左上角选择门店'
    if (dishesFailed) return '菜品加载失败，点此重试'
    if (dishesStoreId !== cur.id) return '菜品加载中…'
    if (!dishes.length) return '该门店还没有菜品，请先添加'
    return dishes[dishIdx] ? dishLabel(dishes[dishIdx]) : '请选择菜品'
  })()

  /**
   * 链接里的创作编号不合法（最典型的是 `?id=undefined`）。
   * 这里既不能去请求（服务端 idParam 回 4000「参数不合法」，指向不了任何操作），
   * 也不能退化成「新建」（用户以为在改一条，提交却新建出第二条）。
   * 唯一的真出路是回创作列表重新进入 —— 所以就把这句话和这个按钮给他。
   */
  if (idBroken) {
    return (
      <View className='cedit'>
        <View className='cedit__bar'>
          <StoreSwitcher />
        </View>
        <View className='cedit__new-head'>
          <Text className='cedit__new-kicker'>LINK BROKEN</Text>
          <Text className='cedit__new-title'>链接里的创作编号有误</Text>
        </View>
        <View className='cedit__card'>
          <Text className='cedit__label'>
            这条链接里的编号不是一个有效的创作号，继续操作只会新建出另一条创作。请回到「创作」列表重新进入。
          </Text>
          <Button
            className='ds-btn ds-btn--primary cedit__submit'
            hoverClass='ds-hover'
            onClick={() => Taro.switchTab({ url: '/pages/creation/list' })}
          >
            回到创作列表
          </Button>
        </View>
      </View>
    )
  }

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
          <Text className='cedit__new-title'>每天5分钟坚持同城曝光！</Text>
          {/* 原来这里的副标题（「选好门店、菜品和表达方向，AI 会帮你…」）已挪到页脚做小字提醒。
              它说的是「接下来要做什么」，摆在标题下方会先于表单占掉一屏注意力；
              而且带「AI」的说法在这里是多余的 —— 按钮和页脚已经说清会发生什么。 */}
        </View>

        {/* ── 流量款独立入口（2026-09-21 从创作列表页挪到标题下面）──
            它是「今天该蹭什么话题」，和下面那张表单（某门店的某道菜）**不是同一类东西**；
            摆在标题正下方，用户一进创作页就能看到「不拍菜、每天也能发一条」这条路。
            ⚠ 生成中（autoRunning）不渲染：那时页面正跑着一次生成，点它会把用户带走，
              只剩一个没人看的等待态（同一段里其他控件之所以能留，是因为它们都不离开本页）。 */}
        {!autoRunning && (
          <View className='cedit__topic' hoverClass='ds-hover--press' onClick={onOpenTraffic}>
            <View className='cedit__topic-icon'>
              <t-icon name='cloud' size='38rpx' />
            </View>
            <View className='cedit__topic-main'>
              <View className='cedit__topic-head'>
                <Text className='cedit__topic-title'>流量款 · 跟热点</Text>
                <Text className='cedit__topic-new'>新</Text>
              </View>
              <Text className='cedit__topic-desc'>不用选门店和菜品，跟着节气、节日和当下话题出文案与分镜</Text>
            </View>
            <t-icon name='chevron-right' size='36rpx' />
          </View>
        )}

        <View className='cedit__card'>
          {/* ★ 这里**没有**「门店」字段（2026-09-21 删）：门店由顶上的 StoreSwitcher 决定，
              本页只负责「这道菜」。同一页放两个门店选择器，用户会以为是两件事，
              而且两个都写全局门店时谁生效取决于点的顺序 ⇒ 表现为「换了一家没生效」。 */}
          <View className='cedit__field'>
            <Text className='cedit__label'>菜品</Text>
            {/* 必选：range 里不再有「不指定」这一项，所以下标与 dishes 一一对应，
                这里也就不再需要 `- 1` 换算（旧写法是「下标 -1 = 不指定」的约定）。 */}
            <Picker
              mode='selector'
              range={dishes.map(dishLabel)}
              onChange={(e: { detail: { value: string | number } }) => setDishIdx(Number(e.detail.value))}
              // 菜品必须确认属于**当前门店**才可点：dishesStoreId 与所选门店不一致时
              // 说明列表还是上一家店的（或还没回来），此时不该让用户选（见 dishesStoreId 的说明）
              disabled={!stores[storeIdx] || !dishes.length || dishesStoreId !== stores[storeIdx]?.id}
            >
              <View className='cedit__picker' onClick={() => dishesFailed && stores[storeIdx] && loadDishesFor(stores[storeIdx]!.id)}>
                {dishPickerText}
              </View>
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
          <OptionList options={DISH_TRACK_OPTIONS} value={track} onChange={onPickTrack} />

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
              options={DISH_TRACK_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
              value={track}
              onChange={onPickTrack}
            />
            <Text className='cedit__desc'>{DISH_TRACK_OPTIONS.find((o) => o.value === track)?.desc}</Text>
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
