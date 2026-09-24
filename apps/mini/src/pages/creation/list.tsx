import { useEffect, useMemo, useRef, useState } from 'react'
import { Image, View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import {
  archiveCreation,
  deleteCreation,
  listCreations,
  unarchiveCreation,
  type CreationItem,
} from '../../services/creation'
import { useMerchantStore } from '../../store/merchant'
import Segmented from '../../components/segmented'
import ProgressLine from '../../components/progress-line'
import SwipeActions, { type SwipeAction } from '../../components/swipe-actions'
// 超过 7 天的绝对时间走统一入口（原来这里手拼 MM-DD，缺年份）
import { formatMinute } from '../../utils/time'
import './list.scss'

type Filter = 'ALL' | 'DOING' | 'READY' | 'ARCHIVED'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'ALL', label: '全部' },
  { value: 'DOING', label: '进行中' },
  { value: 'READY', label: '已就绪' },
  { value: 'ARCHIVED', label: '归档' },
]

/**
 * ── 创作进度：按真实环节分段累加 ───────────────────────────────
 *
 * 权重：文案 30 / 分镜 20 / 素材 40 / 合成 10。
 * 每段都 ≥ 10 ⇒ 0~100 里任何一个 5 的倍数都可达；
 * 早先是「文案 50 + 分镜 50」两段非 0 即满，于是全站只有 0 / 50 / 100 三个值。
 *
 * 素材段是唯一的连续段（已上传分镜数 / 分镜总数 × 40，四舍五入），
 * 所以实际会落在 0、30、50、58、66、74、82、90、93、96、100 这些点上。
 *
 * 字段来源（服务端 listCreations 一次带齐，不是 N+1）：
 *   copyText    口播文案是否已生成
 *   shotsTotal  分镜总数（= 0 表示分镜还没排）
 *   shotsReady  其中已上传素材的分镜数
 *   renderStatus 最新一条合成任务的 status；null = 从未发起过合成
 */
const W_COPY = 30
const W_SHOTS = 20
const W_ASSET = 40
const W_RENDER = 10

/** 合成阶段在最后 10% 里的细分：状态越靠后越接近 100 */
const RENDER_STEP: Record<string, number> = {
  PENDING_RESERVATION: 2,
  QUEUED: 3,
  SETTLEMENT_PENDING: 3,
  MANUAL_PENDING: 4,
  RUNNING: 6,
  MANUAL_DOING: 6,
  SUCCESS: W_RENDER,
}

/** 合成阶段的短文案。失败/取消等不在 RENDER_STEP 里，进度停在素材段末尾且文案点明可重试 */
function renderLabel(status: string | null): string {
  switch (status) {
    case null:
      return '待合成'
    case 'SUCCESS':
      return '已合成成片'
    case 'RUNNING':
      return '成片合成中'
    case 'MANUAL_DOING':
      return '剪辑师制作中'
    case 'MANUAL_PENDING':
      return '等待剪辑师接单'
    case 'QUEUED':
      return '合成排队中'
    case 'SETTLEMENT_PENDING':
      return '退款确认中'
    case 'PENDING_RESERVATION':
      return '合成准备中'
    default:
      return '合成未完成，可重试'
  }
}

interface Progress {
  /** 0 - 100，只喂给进度条 */
  pct: number
  /** 紧跟百分数的短状态：一眼看出卡在哪一步 */
  label: string
  /**
   * 「进行中 / 已就绪」分类的边界 = **文案与分镜都已生成**（= 已进入可传素材/合成阶段）。
   * 刻意与改造前保持一致，不让它跟着 pct 的粒度一起变 ——
   * 否则所有老项目会从「已就绪」集体掉进「进行中」，分类计数也跟着全变。
   */
  renderReady: boolean
}

function progressOf(c: CreationItem): Progress {
  const total = c.shotsTotal
  // 已上传数不可能超过总数，但服务端字段一旦漂移就会算出 >100% 的进度条
  const done = Math.max(0, Math.min(c.shotsReady, total))

  let pct = 0
  if (c.copyText) pct += W_COPY
  if (total > 0) pct += W_SHOTS
  // total = 0 时不做除法：0/0 是 NaN，会把进度条整个打回 0
  if (total > 0) pct += Math.round((done / total) * W_ASSET)
  pct += RENDER_STEP[c.renderStatus ?? ''] ?? 0
  pct = Math.max(0, Math.min(100, pct))

  // 文案一律跟**进度条走到的那一步**对齐：不能出现「条已经 47% 却写着待生成文案」。
  // 所以判据用 total（分镜有没有排出来），而不是 copyText（文案有没有写）。
  let label: string
  if (total === 0) label = c.copyText ? '待生成分镜' : '待生成文案'
  else if (done < total) label = `素材 ${done}/${total}`
  else label = renderLabel(c.renderStatus)

  return { pct, label, renderReady: !!c.copyText && total > 0 }
}

/**
 * 列表时间：近 7 天用相对时间（刚刚 / x 分钟前 / x 小时前 / 昨天 / x 天前），
 * 更早的直接给**统一口径的绝对时间** `2026-09-11 14:30`（走 utils/time 的 formatMinute）。
 * ★ 原来更早那一档是 `MM-DD`（连年份都没有）：跨年时「01-05」分不清是哪一年，
 *   而且它是全项目唯一一个绕开统一入口的绝对时间。
 */
function fmtRelTime(iso: string): string {
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diff = Math.max(0, now - then)
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d === 1) return '昨天'
  if (d < 7) return `${d} 天前`
  return formatMinute(iso)
}

/** 创作列表：内容全部挂在账号唯一的那家门店下（★ 单店模型 2026-09-24，顶上门店切换器已删除） */
export default function CreationList() {
  const currentStoreId = useMerchantStore((s) => s.currentStoreId)
  const stores = useMerchantStore((s) => s.stores)
  const loadStores = useMerchantStore((s) => s.loadStores)
  /** 未归档列表：「全部 / 进行中 / 已就绪」都从它派生 */
  const [list, setList] = useState<CreationItem[]>([])
  /** 已归档列表：「归档」分类专用。服务端按 archived=1 单独下发 */
  const [archived, setArchived] = useState<CreationItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [filter, setFilter] = useState<Filter>('ALL')
  /** 当前展开左滑的那一行 id（空串 = 全部收起）。放在页面级是为了保证一次只展开一行 */
  const [openId, setOpenId] = useState('')

  /** 请求代次：切店 / 动作后重载 / 每次显示都会发请求，乱序回包只认最后一次 */
  const reqRef = useRef(0)

  const load = async () => {
    // 无门店：不拉数据（页面显示建店引导）
    if (!currentStoreId) {
      setList([])
      setArchived([])
      return
    }
    const sid = currentStoreId
    const my = ++reqRef.current
    setLoading(true)
    setLoadError('')
    try {
      await loadStores().catch(() => [])
      // 两个列表一起拉：分类上要显示各自的数量，切分类时也不必再请求
      const [active, done] = await Promise.all([
        listCreations(sid),
        listCreations(sid, { archived: true }),
      ])
      // ★ 只认最新一次：切店后旧店的慢响应若覆盖列表，用户看到的就是别家店的创作
      if (my !== reqRef.current) return
      setList(active)
      setArchived(done)
    } catch (error) {
      if (my !== reqRef.current) return
      setLoadError((error as Error).message || '创作列表加载失败，请重试')
    } finally {
      if (my === reqRef.current) setLoading(false)
    }
  }

  useDidShow(() => { void load() })

  useEffect(() => {
    Taro.setNavigationBarTitle({ title: '我的创作' })
  }, [])

  // 门店切换后立即重载（首次挂载由 useDidShow 负责，避免重复请求）
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    void load()
  }, [currentStoreId])

  // 进度、文案、分类边界都只算一次：分类计数 + 筛选 + 渲染三处都要用，
  // 每个都各调一次 progressOf 的话，同一张卡片会被算三遍。
  const items = useMemo(() => list.map((c) => ({ c, ...progressOf(c) })), [list])
  const archivedItems = useMemo(() => archived.map((c) => ({ c, ...progressOf(c) })), [archived])

  const counts = useMemo(() => {
    const doing = items.filter((i) => !i.renderReady).length
    return { ALL: items.length, DOING: doing, READY: items.length - doing, ARCHIVED: archivedItems.length }
  }, [items, archivedItems])

  // 「归档后不出现在全部/进行中/已就绪」由**服务端**保证（默认列表已排除已归档的），
  // 这里不再叠加本地过滤 —— 两处判断一旦不一致就会出现「刚归档的又冒出来」。
  const visible = useMemo(() => {
    if (filter === 'ARCHIVED') return archivedItems
    if (filter === 'DOING') return items.filter((i) => !i.renderReady)
    if (filter === 'READY') return items.filter((i) => i.renderReady)
    return items
  }, [items, archivedItems, filter])

  const filters = useMemo(
    () => FILTERS.map((f) => ({ value: f.value, label: `${f.label} ${counts[f.value]}` })),
    [counts],
  )

  const storeNameOf = (id: string) => stores.find((s) => s.id === id)?.name || '门店'

  const onCreate = () => currentStoreId
    ? Taro.navigateTo({ url: '/pages/creation/edit' })
    : Taro.switchTab({ url: '/pages/home/index' })

  /**
   * 点开一条创作。
   * ★ 2026-09-24 起**不再按 mode 分流**：独立的「流量款 · 跟热点」页已删除，流量型并入创作页的
   *   「文案款式」，所以话题稿与菜品稿都进 `pages/creation/edit`。
   *   ⚠ 别把分流逻辑再加回来：那个三元一旦指向一个不存在的页面，`navigateTo` 只会**静默失败**
   *     —— 用户看到的是「点了没反应」，既不报错也没有落点。创作页对话题稿的处理是现成的：
   *     款式钉成流量型、菜品那一行置灰、不显示服务端挑的宿主门店。
   */
  const onOpen = (id: string) => Taro.navigateTo({ url: `/pages/creation/edit?id=${id}` })

  // ⚠ 列表页自己的「流量款」入口卡已于 2026-09-21 挪到创作页，2026-09-24 随独立页一起删除。
  //   本页去话题稿的路只剩下面列表里 mode=TOPIC 的卡片（走上面的 `onOpen`）。

  /** 动作统一收口：成功提示 + 重载。列表是唯一数据源，不在本地增删（避免与服务端不一致） */
  const runAction = async (fn: () => Promise<unknown>, okText: string) => {
    try {
      await fn()
      Taro.showToast({ title: okText, icon: 'success' })
      await load()
    } catch (e) {
      Taro.showToast({ title: (e as { message?: string })?.message ?? '操作失败，请重试', icon: 'none', duration: 2500 })
    }
  }

  /** 归档不需要二次确认：它是可逆的（归档分类里能恢复） */
  const onArchive = (id: string) => void runAction(() => archiveCreation(id), '已归档')

  const onUnarchive = (id: string) => void runAction(() => unarchiveCreation(id), '已恢复')

  /** 删除不可恢复 ⇒ 必须先弹确认，确认后才真的发请求 */
  const onDelete = async (id: string) => {
    const r = await Taro.showModal({
      title: '删除创作',
      content: '删除后无法恢复',
      confirmText: '删除',
      confirmColor: '#d54941',
      cancelText: '取消',
    })
    if (!r.confirm) return
    await runAction(() => deleteCreation(id), '已删除')
  }

  return (
    <View className='clist'>
      {/* ★ 2026-09-24 按需求：右上角那个「+」新建按钮已删除。
          它原先待在 `clist__bar` 这一行里，同行的另一个子项是门店切换器（已在同一轮单店模型
          改造里下线）——行内再无子项，留着就是一个空盒子，于是连定位行一起删除。
          本页现在唯一的新建入口是下面空态里的「新建创作」；列表非空时本页不再提供新建入口。 */}

      {/* ⚠ 本页**不再有**「流量款」入口卡：它 2026-09-21 挪到创作页标题下面，
          2026-09-24 随「流量型并入文案款式」一起删除（独立页 `pages/creation/traffic` 已不存在）。
          现在新建流量型只有一条路：进创作页，在「文案款式」里选第一项。
          原本还有一条「右上角『+』进创作页」，那个按钮已按需求删除（2026-09-24）。这里不要再加回来。 */}

      {currentStoreId && (
        <Segmented
          className='clist__filter'
          options={filters}
          value={filter}
          onChange={(v) => {
            // 切分类时收起左滑：否则展开的那一行会「跨分类」残留在新列表上
            setOpenId('')
            setFilter(v as Filter)
          }}
        />
      )}

      {!currentStoreId && !loading && (
        <View className='ds-empty'>
          <Text className='ds-empty__text'>还没有门店，先创建一家门店，创作会挂在门店下</Text>
          <View className='ds-empty__action' hoverClass='ds-hover' onClick={() => Taro.switchTab({ url: '/pages/home/index' })}>去选门店</View>
        </View>
      )}

      {currentStoreId && loading && <View className='clist__tip'>加载中…</View>}

      {currentStoreId && !loading && !!loadError && (
        <View className='ds-empty'>
          <Text className='ds-empty__text'>{loadError}</Text>
          <View className='ds-empty__action' hoverClass='ds-hover' onClick={() => void load()}>重新加载</View>
        </View>
      )}

      {currentStoreId && !loading && !loadError && visible.length === 0 && (
        <View className='ds-empty'>
          <Text className='ds-empty__text'>
            {filter === 'ALL'
              ? `「${storeNameOf(currentStoreId)}」还没有创作`
              : filter === 'DOING'
                ? '没有进行中的创作'
                : filter === 'READY'
                  ? '还没有已就绪的创作'
                  : '归档里还没有创作'}
          </Text>
          {filter === 'ALL' && <View className='ds-empty__action' hoverClass='ds-hover' onClick={onCreate}>新建创作</View>}
        </View>
      )}

      {visible.map(({ c, pct, label }) => {
        // 归档分类下左滑是「恢复 / 删除」，其余分类是「归档 / 删除」
        const actions: SwipeAction[] = filter === 'ARCHIVED'
          ? [
              { key: 'unarchive', label: '恢复', onClick: () => onUnarchive(c.id) },
              { key: 'delete', label: '删除', danger: true, onClick: () => void onDelete(c.id) },
            ]
          : [
              { key: 'archive', label: '归档', onClick: () => onArchive(c.id) },
              { key: 'delete', label: '删除', danger: true, onClick: () => void onDelete(c.id) },
            ]
        return (
          <SwipeActions
            key={c.id}
            className='clist__swipe'
            actions={actions}
            open={openId === c.id}
            onOpenChange={(o) => setOpenId(o ? c.id : '')}
            onClick={() => onOpen(c.id)}
          >
            <View className='clist__card' hoverClass='ds-hover--press'>
              <View className='clist__row'>
                {/* 卡片缩略图：有已上传的视频就显示它的封面，没有才退回默认图标。
                    coverUrl 由服务端算好（第一个已上传视频的封面），前端不做判断 —— 
                    与分镜页/合成页的「有素材就显示缩略图」保持同一套判据。 */}
                <View className='clist__cover'>
                  {c.coverUrl ? (
                    <Image className='clist__cover-image' src={c.coverUrl} mode='aspectFill' />
                  ) : (
                    <t-icon name='movie-clapper' size='36rpx' />
                  )}
                </View>
                <View className='clist__main'>
                  <Text className='clist__name'>{c.title || '未命名创作'}</Text>
                  <View className='clist__tags'>
                    {/* 话题稿的款式恒为流量型（服务端也这么落库），所以这一格照样显示款式名。
                        ★ 2026-09-24 之前这里显示的是「话题稿」并注明「款式在话题稿里不是可选项」——
                        那句前提已经不成立：流量型就是创作页「文案款式」里的第一项、用户亲手选的。
                        再显示「话题稿」等于给同一件东西起第二个名字（用户会当成另一类创作）。 */}
                    {c.mode === 'TOPIC' ? (
                      <Text className='ds-pill ds-pill--red-soft'>流量型</Text>
                    ) : (
                      !!c.trackLabel && <Text className='ds-pill ds-pill--red-soft'>{c.trackLabel}</Text>
                    )}
                    {!!c.complexityLabel && <Text className='ds-pill ds-pill--gray'>{c.complexityLabel}</Text>}
                    <Text className='clist__shots'>分镜 {c.shotsTotal}</Text>
                    <Text className='clist__time'>{fmtRelTime(c.createdAt)}</Text>
                  </View>
                </View>
              </View>

              {/* 进度条在上、文案与百分数在下同一行；原来那条独立的「状态 pill + 继续制作 ›」
                  已经并入这里的 label，卡片因此少一整行 */}
              <ProgressLine className='clist__progress' percent={pct} label={label} />
            </View>
          </SwipeActions>
        )
      })}
    </View>
  )
}
