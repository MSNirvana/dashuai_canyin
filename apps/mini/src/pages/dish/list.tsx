import { useEffect, useRef, useState } from 'react'
import { View, Text, Image } from '@tarojs/components'
import Taro, { useRouter, useDidShow } from '@tarojs/taro'
import { listDishes, deleteDish, getDishMediaUrl, type DishItem, type DishKind } from '../../services/dish'
import { useMerchantStore } from '../../store/merchant'
import StoreSwitcher from '../../components/store-switcher'
import Segmented from '../../components/segmented'
import { readRouteId } from '../../utils/route-id'
import { fenToYuan } from '../../utils/money'
import './list.scss'

/** 列表筛选：全部 / 只看单菜 / 只看套餐 */
type Filter = 'ALL' | DishKind

/** 菜品库：跟随左上角当前门店（门店为最高层，菜品全部跟门店走） */
export default function DishListPage() {
  const router = useRouter()
  const currentStoreId = useMerchantStore((s) => s.currentStoreId)
  const stores = useMerchantStore((s) => s.stores)
  const setStore = useMerchantStore((s) => s.setStore)
  const loadStores = useMerchantStore((s) => s.loadStores)
  const [list, setList] = useState<DishItem[]>([])
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  /**
   * 类型筛选。
   * ★ 它是**本地筛选**而不是重新请求：菜品库按门店整体加载（菜单的量级，几十条），
   *   切筛选再打一次接口只会让列表闪一下，还要处理「切回来时数据旧了」。
   */
  const [filter, setFilter] = useState<Filter>('ALL')
  /**
   * 加载失败的原因。
   * ★ 与「这家店真的没有菜品」必须分开：旧实现把失败静默吞成空列表，
   *   页面于是显示「添加第一道菜」—— 用户有菜也会以为没有，跑去重复添加。
   */
  const [loadError, setLoadError] = useState('')
  /** 请求代次：切店 / 重复显示并发时，乱序回包只认最后一次（否则旧店的菜覆盖新店的列表） */
  const reqRef = useRef(0)

  // 从门店管理带 storeId 进来时，同步为全局当前门店，保持全站上下文一致。
  // ★ 必须过 readRouteId：`?storeId=undefined` 会让这里把全局门店**真的切到 'undefined'**，
  //   之后 listDishes('undefined') 吃一个 4000，页面显示「这家店没有菜品」——
  //   而用户明明有菜，看起来就像数据丢了（详见 utils/route-id.ts）。
  const paramStoreId = readRouteId(router.params, 'storeId')
  useEffect(() => {
    if (paramStoreId && paramStoreId !== currentStoreId) setStore(paramStoreId)
  }, [paramStoreId])

  const load = async () => {
    if (!currentStoreId) {
      setList([])
      setLoading(false)
      return
    }
    const my = ++reqRef.current
    setLoading(true)
    try {
      const data = await listDishes(currentStoreId)
      if (my !== reqRef.current) return
      setList(data)
      setLoadError('')
      const entries = await Promise.all(
        data.map(async (d) => {
          const key = d.media?.find((m) => m.type === 'IMAGE')?.cosKey || d.coverKey
          if (!key) return null
          try {
            const r = await getDishMediaUrl(key)
            return r.url ? ([d.id, r.url] as const) : null
          } catch {
            return null
          }
        }),
      )
      // 封面是第二轮请求，回来时页面可能已经在看另一家店 —— 同样要比代次
      if (my !== reqRef.current) return
      setCoverUrls(Object.fromEntries(entries.filter((x): x is readonly [string, string] => !!x)))
    } catch {
      if (my !== reqRef.current) return
      /**
       * ★ 原来这里只有 `finally`、没有 `catch`：两个后果一起发生 ——
       *   ① 请求失败变成**未处理的 Promise rejection**（调用点写的是 `void load()`）；
       *   ② `list` 保持原样、`loading` 转 false，界面落进「把招牌菜变成创作素材 / 添加第一道菜」
       *      那个**空态** —— 用户明明有菜，看到的却是「你还没有菜品」，
       *      于是去重复添加，或者以为数据丢了。
       *   失败必须与「真没有数据」长得不一样，并给一个原地重试的出口。
       */
      setLoadError('菜品加载失败，点这里重试')
    } finally {
      if (my === reqRef.current) setLoading(false)
    }
  }

  useDidShow(() => {
    void loadStores().catch(() => undefined)
    void load()
  })

  // 门店切换后立即重载（首次挂载由 useDidShow 负责，避免重复请求）
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    // ★ 换店后筛选回到「全部」：在 A 店选了「只看套餐」，切到 B 店时筛选还生效，
    //   而 B 店恰好没有套餐 —— 用户看到的是「还没有套餐」，很容易以为 B 店的菜丢了
    //   （他不知道筛选器还停在上一次的选择上）。
    setFilter('ALL')
    void load()
  }, [currentStoreId])

  const onDelete = (d: DishItem) =>
    Taro.showModal({
      title: d.kind === 'COMBO' ? '删除套餐' : '删除菜品',
      content: `确认删除「${d.name}」？`,
      confirmColor: '#e1251b',
    }).then(async (r) => {
      if (!r.confirm) return
      try {
        await deleteDish(currentStoreId, d.id)
        Taro.showToast({ title: '已删除', icon: 'success' })
        load()
      } catch {
        /* request layer 已提示（例如「该菜品已被 N 个套餐引用，请先从套餐里移除」） */
      }
    })

  const onAdd = () => Taro.navigateTo({ url: '/pages/dish/edit' })
  const onDetail = (d: DishItem) => Taro.navigateTo({ url: '/pages/dish/detail?id=' + d.id })
  const storeName = stores.find((s) => s.id === currentStoreId)?.name || ''

  const singleCount = list.filter((d) => d.kind !== 'COMBO').length
  const comboCount = list.filter((d) => d.kind === 'COMBO').length
  const visible = filter === 'ALL' ? list : list.filter((d) => (filter === 'COMBO' ? d.kind === 'COMBO' : d.kind !== 'COMBO'))

  return (
    <View className='dish-list'>
      <View className='dish-list__head'>
        <View>
          <Text className='dish-list__eyebrow'>MENU ASSETS</Text>
          <Text className='dish-list__title'>菜品库</Text>
          <Text className='dish-list__intro'>让每一道招牌菜，都有自己的出镜方式</Text>
        </View>
        {list.length > 0 && <Text className='dish-list__count'>{list.length} 道</Text>}
      </View>
      <View className='dish-list__bar'>
        <StoreSwitcher />
        {storeName && <Text className='dish-list__barhint'>菜品归属该门店</Text>}
      </View>

      {/* 有菜才显示筛选器：空列表时它只是一排点了没反应的按钮 */}
      {currentStoreId && !loading && !loadError && list.length > 0 && (
        <View className='dish-list__filter'>
          <Segmented
            options={[
              { value: 'ALL', label: `全部 ${list.length}` },
              { value: 'SINGLE', label: `单菜 ${singleCount}` },
              { value: 'COMBO', label: `套餐 ${comboCount}` },
            ]}
            value={filter}
            onChange={(v) => setFilter(v as Filter)}
          />
        </View>
      )}

      {!currentStoreId && !loading && (
        <View className='dish-list__empty'>
          <Text className='dish-list__empty-kicker'>先有门店，再有招牌菜</Text>
          <Text className='dish-list__empty-title'>建立你的第一份菜单资产</Text>
          <Text className='dish-list__empty-desc'>创建门店后，把菜品照片、卖点和介绍放进来，创作时可以直接选用。</Text>
          <View className='dish-list__empty-action' onClick={() => Taro.navigateTo({ url: '/pages/store/list' })}>去创建门店</View>
        </View>
      )}
      {currentStoreId && loading && (
        <View className='dish-list__loading'><Text>加载中…</Text></View>
      )}
      {/* 失败态必须排在空态**前面**：加载失败时 list 也是空的，
          若让空态先命中，用户看到的仍然是「添加第一道菜」 */}
      {currentStoreId && !loading && !!loadError && (
        <View className='dish-list__empty' onClick={() => void load()}>
          <Text className='dish-list__empty-title'>{loadError}</Text>
        </View>
      )}
      {currentStoreId && !loading && !loadError && list.length === 0 && (
        <View className='dish-list__empty'>
          <Text className='dish-list__empty-kicker'>从一道最拿手的开始</Text>
          <Text className='dish-list__empty-title'>把招牌菜变成创作素材</Text>
          <Text className='dish-list__empty-desc'>上传一张好看的菜品图，再写下顾客最容易被打动的卖点。</Text>
          <View className='dish-list__empty-action' onClick={onAdd}>添加第一道菜</View>
        </View>
      )}
      {/*
        ★ 「筛完之后什么都没有」必须与「这家店真的没有菜」分开说。
          两者共用同一套空态文案的话，用户在「套餐」筛选下会看到
          「把招牌菜变成创作素材 / 添加第一道菜」—— 他明明有 8 道菜，
          只会以为数据丢了，或者跑去再建一道已经有的菜。
      */}
      {currentStoreId && !loading && !loadError && list.length > 0 && visible.length === 0 && (
        <View className='dish-list__empty'>
          <Text className='dish-list__empty-kicker'>{filter === 'COMBO' ? '还没有套餐' : '还没有单菜'}</Text>
          <Text className='dish-list__empty-title'>
            {filter === 'COMBO' ? '几道菜组成一组，拍摄时一次选齐' : '这家店的菜品库里目前只有套餐'}
          </Text>
          <Text className='dish-list__empty-desc'>
            {filter === 'COMBO'
              ? '拍「一桌怎么搭配」这类视频时，一次就能把这几道菜的图挑好。'
              : '单菜是套餐的组成，先建几道常拍的菜，就能组合成套餐。'}
          </Text>
          <View className='dish-list__empty-action' onClick={() => setFilter('ALL')}>看看全部</View>
        </View>
      )}

      {currentStoreId && !loading && visible.length > 0 && (
        <View className='dish-list__items'>
          {visible.map((d) => (
            <View key={d.id} className={'dish-card' + (d.kind === 'COMBO' ? ' dish-card--combo' : '')} onClick={() => onDetail(d)}>
              <View className='dish-card__row'>
                <View className='dish-card__cover'>
                  {coverUrls[d.id] ? (
                    <Image className='dish-card__cover-image' src={coverUrls[d.id]} mode='aspectFill' />
                  ) : (
                    <Text className='dish-card__cover-empty'>{d.kind === 'COMBO' ? '套餐' : '菜品'}</Text>
                  )}
                </View>
                <View className='dish-card__main'>
                  <View className='dish-card__title-row'>
                    <Text className='dish-card__name'>{d.name}</Text>
                    {/*
                      ★ 套餐卡**只挂「套餐」这一个标签**，不再同时挂「招牌卖点」：
                        标题行是 名称 + 标签们 + 删除，全都不许收缩（flex: 0 0 auto），
                        名称只能靠 ellipsis 让位。四个元素挤在 430rpx 里，
                        再加上店铺名一长就会把名称压成「双人…」。
                        套餐的类型标签比「有卖点」这个提示重要，留它；
                        卖点正文本来就在下面显示，并不因为少了标签而看不见。
                    */}
                    {d.kind === 'COMBO' ? (
                      <Text className='dish-card__badge dish-card__badge--combo'>套餐</Text>
                    ) : (
                      d.sellingPoints && <Text className='dish-card__badge'>招牌卖点</Text>
                    )}
                    {/* 删除并进标题行右端：贴在内容里，不再是卡片最右边一个孤立标签 */}
                    <Text className='dish-card__del' onClick={(e) => { e.stopPropagation(); onDelete(d) }}>删除</Text>
                  </View>
                  {d.kind === 'COMBO' && (
                    <View className='dish-card__combo'>
                      <Text className='dish-card__price'>¥{fenToYuan(d.priceFen ?? 0)}</Text>
                      {!!d.originalPriceFen && <Text className='dish-card__price-was'>¥{fenToYuan(d.originalPriceFen)}</Text>}
                      <Text className='dish-card__combo-count'>含 {d.comboItems?.length ?? 0} 样</Text>
                    </View>
                  )}
                  {d.sellingPoints && <Text className='dish-card__sp'>{d.sellingPoints}</Text>}
                  {d.intro && <Text className='dish-card__intro'>{d.intro}</Text>}
                </View>
              </View>
            </View>
          ))}
        </View>
      )}

      {currentStoreId && (
        <View className='dish-list__footer'>
          <View className='dish-list__add' onClick={onAdd}><Text>+ 添加菜品</Text></View>
        </View>
      )}
    </View>
  )
}
