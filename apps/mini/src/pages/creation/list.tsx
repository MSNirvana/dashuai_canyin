import { useEffect, useMemo, useRef, useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { listCreations, type CreationItem } from '../../services/creation'
import { useMerchantStore } from '../../store/merchant'
import StoreSwitcher from '../../components/store-switcher'
import Segmented from '../../components/segmented'
import ProgressLine from '../../components/progress-line'
import './list.scss'

type Filter = 'ALL' | 'DOING' | 'READY'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'ALL', label: '全部' },
  { value: 'DOING', label: '进行中' },
  { value: 'READY', label: '已就绪' },
]

/**
 * 创作进度：只依据列表里真实存在的字段判定。
 * 后端 Creation.status 目前恒为 DRAFT、从不写入，不能作为筛选依据。
 * 文案已生成 = 50%，分镜已生成 = 50%，两者齐备即「已就绪」（可继续上传素材 / 合成）。
 */
function progressOf(c: CreationItem): number {
  return (c.copyText ? 50 : 0) + ((c._count?.shots ?? 0) > 0 ? 50 : 0)
}

function statusText(pct: number): string {
  if (pct >= 100) return '已就绪 · 可继续合成'
  if (pct >= 50) return '待生成分镜'
  return '待生成文案'
}

/** 相对时间：2 小时前 / 昨天 / 09-11 */
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
  const date = new Date(iso)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 创作列表：跟随左上角当前门店（门店为最高层，内容全部跟门店走） */
export default function CreationList() {
  const currentStoreId = useMerchantStore((s) => s.currentStoreId)
  const stores = useMerchantStore((s) => s.stores)
  const loadStores = useMerchantStore((s) => s.loadStores)
  const [list, setList] = useState<CreationItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [filter, setFilter] = useState<Filter>('ALL')

  const load = async () => {
    // 无门店：不拉数据（页面显示建店引导）
    if (!currentStoreId) {
      setList([])
      return
    }
    setLoading(true)
    setLoadError('')
    try {
      await loadStores().catch(() => [])
      setList(await listCreations(currentStoreId))
    } catch (error) {
      setLoadError((error as Error).message || '创作列表加载失败，请重试')
    } finally {
      setLoading(false)
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

  const counts = useMemo(() => {
    const doing = list.filter((c) => progressOf(c) < 100).length
    return { ALL: list.length, DOING: doing, READY: list.length - doing }
  }, [list])

  const visible = useMemo(() => {
    if (filter === 'DOING') return list.filter((c) => progressOf(c) < 100)
    if (filter === 'READY') return list.filter((c) => progressOf(c) >= 100)
    return list
  }, [list, filter])

  const filters = useMemo(
    () => FILTERS.map((f) => ({ value: f.value, label: `${f.label} ${counts[f.value]}` })),
    [counts],
  )

  const storeNameOf = (id: string) => stores.find((s) => s.id === id)?.name || '门店'

  const onCreate = () => currentStoreId
    ? Taro.navigateTo({ url: '/pages/creation/edit' })
    : Taro.switchTab({ url: '/pages/home/index' })
  const onOpen = (id: string) => Taro.navigateTo({ url: `/pages/creation/edit?id=${id}` })

  return (
    <View className='clist'>
      {/* ── 顶部：项目库定位 + 新建 ── */}
      <View className='clist__head'>
        <View>
          <Text className='clist__eyebrow'>PROJECTS</Text>
          <Text className='clist__title'>创作项目</Text>
          <Text className='clist__intro'>每一条视频，都是一次客流机会</Text>
        </View>
        <View className='clist__new' hoverClass='ds-hover' onClick={onCreate}>
          <t-icon name='add' size='40rpx' />
        </View>
      </View>

      <View className='clist__bar'>
        <StoreSwitcher />
      </View>

      {currentStoreId && <Segmented className='clist__filter' options={filters} value={filter} onChange={(v) => setFilter(v as Filter)} />}

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
              ? `「${storeNameOf(currentStoreId)}」还没有创作，点右上角开始`
              : filter === 'DOING'
                ? '没有进行中的创作'
                : '还没有已就绪的创作'}
          </Text>
          {filter === 'ALL' && <View className='ds-empty__action' hoverClass='ds-hover' onClick={onCreate}>新建创作</View>}
        </View>
      )}

      {visible.map((c) => {
        const pct = progressOf(c)
        const ready = pct >= 100
        return (
          <View className='clist__card' key={c.id} hoverClass='ds-hover--press' onClick={() => onOpen(c.id)}>
            <View className='clist__row'>
              <View className='clist__cover'>
                <t-icon name='movie-clapper' size='40rpx' />
              </View>
              <View className='clist__main'>
                <Text className='clist__name'>{c.title || '未命名创作'}</Text>
                <View className='clist__tags'>
                  {!!c.trackLabel && <Text className='ds-pill ds-pill--red-soft'>{c.trackLabel}</Text>}
                  {!!c.complexityLabel && <Text className='ds-pill ds-pill--gray'>{c.complexityLabel}</Text>}
                  <Text className='clist__shots'>分镜 {c._count?.shots ?? 0}</Text>
                  <Text className='clist__time'>{fmtRelTime(c.createdAt)}</Text>
                </View>
              </View>
            </View>

            <View className='clist__status'>
              <Text className={`ds-pill ${ready ? 'ds-pill--green' : 'ds-pill--gold'}`}>{statusText(pct)}</Text>
              <Text className='clist__continue'>{ready ? '继续制作 ›' : '补齐内容 ›'}</Text>
            </View>

            <ProgressLine percent={pct} hint={ready ? '可继续上传素材并合成成片' : undefined} />
          </View>
        )
      })}
    </View>
  )
}
