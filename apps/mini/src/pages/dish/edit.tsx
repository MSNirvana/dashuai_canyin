import { useEffect, useState } from 'react'
import { View, Text, Input, Textarea, Image, Video } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { createDish, updateDish, getDish, listDishes, getDishMediaUrl, type DishInput, type DishItem, type DishKind, type DishMedia } from '../../services/dish'
import { uploadMediaFile } from '../../services/upload'
import { useMerchantStore } from '../../store/merchant'
import Segmented from '../../components/segmented'
import { readRouteId, isBrokenRouteId } from '../../utils/route-id'
import { fenToYuan, yuanToFen } from '../../utils/money'
import './edit.scss'

interface LocalMedia { type: 'IMAGE' | 'VIDEO'; cosKey: string; coverKey?: string; sort: number; url: string; coverUrl?: string }

/** 套餐里选中的一样东西。只存 dishId + 份数，菜名仅用于显示（真名以服务端为准） */
interface ComboPick { dishId: string; name: string; quantity: number }

interface FormState {
  name: string
  intro: string
  sellingPoints: string
  images: LocalMedia[]
  videos: LocalMedia[]
  kind: DishKind
  /** 价格在表单里是**「元」的字符串**（用户输入的原文），提交时才转成分 */
  price: string
  originalPrice: string
  combo: ComboPick[]
}
const EMPTY: FormState = {
  name: '', intro: '', sellingPoints: '', images: [], videos: [],
  kind: 'SINGLE', price: '', originalPrice: '', combo: [],
}

async function toLocalMedia(m: DishMedia): Promise<LocalMedia> {
  const result = await getDishMediaUrl(m.cosKey).catch(() => ({ url: null }))
  let coverUrl = ''
  if (m.coverKey) { try { coverUrl = (await getDishMediaUrl(m.coverKey)).url || '' } catch { /* placeholder */ } }
  return { type: m.type, cosKey: m.cosKey, coverKey: m.coverKey || undefined, sort: m.sort, url: result.url || '', coverUrl }
}

export default function DishEditPage() {
  const router = useRouter(); const { currentStoreId } = useMerchantStore(); const storeId = readRouteId(router.params, 'storeId') ?? currentStoreId; const id = readRouteId(router.params) ?? undefined
  /**
   * 路由里带了编号但不合法（最典型的是字符串 'undefined'）。
   * ★ 不能退化成「新建」：用户以为在改这道菜，保存后却新建出另一道 —— 原来那道原样没动。
   *   所以坏链接必须拦住（详见 utils/route-id.ts）。
   */
  const idBroken = isBrokenRouteId(router.params) || isBrokenRouteId(router.params, 'storeId')
  const [form, setForm] = useState<FormState>(EMPTY); const [loaded, setLoaded] = useState(false); const [saving, setSaving] = useState(false); const [uploading, setUploading] = useState(false)
  /**
   * 可被选进套餐的候选菜（本门店的**单菜**）。
   * 单独一个 state 而不是从 form 里推：form 是用户在编的那一条，候选是整个菜单。
   * `candidatesFailed` 与「这家店真的没有单菜」必须分开 —— 同 list.tsx 里那条失败的教训。
   */
  const [candidates, setCandidates] = useState<DishItem[]>([])
  const [candidatesFailed, setCandidatesFailed] = useState(false)

  useEffect(() => {
    if (!storeId) { setLoaded(true); return }
    // 候选菜与「正在编辑的这条」并行拉取：两者互不依赖，串行只会让页面多等一个来回
    void listDishes(storeId)
      .then((all) => {
        setCandidates(all.filter((d) => d.kind !== 'COMBO'))
        setCandidatesFailed(false)
      })
      .catch(() => setCandidatesFailed(true))
    if (!id) { setLoaded(true); return }
    getDish(storeId, id).then(async (d: DishItem) => {
      const legacy: DishMedia[] = d.media?.length ? d.media : [...(d.coverKey ? [{ type: 'IMAGE' as const, cosKey: d.coverKey, sort: 0 }] : []), ...(d.videoKey ? [{ type: 'VIDEO' as const, cosKey: d.videoKey, sort: 0 }] : [])]
      const media = await Promise.all(legacy.map(toLocalMedia))
      setForm({
        name: d.name,
        intro: d.intro || '',
        sellingPoints: d.sellingPoints || '',
        images: media.filter((m) => m.type === 'IMAGE'),
        videos: media.filter((m) => m.type === 'VIDEO'),
        kind: d.kind === 'COMBO' ? 'COMBO' : 'SINGLE',
        // 分 → 元的**回填**：用 fenToYuan 而不是 `String(fen / 100)`，
        // 否则 8800 分会回填成 "88"（好），而 8850 分会回填成 "88.5"（也对）——
        // 关键是别出现 "88.50000001" 这类浮点尾巴把用户吓一跳。
        price: d.priceFen === null || d.priceFen === undefined ? '' : fenToYuan(d.priceFen),
        originalPrice: d.originalPriceFen === null || d.originalPriceFen === undefined ? '' : fenToYuan(d.originalPriceFen),
        combo: (d.comboItems ?? []).map((it) => ({ dishId: it.dishId, name: it.name, quantity: it.quantity })),
      })
    }).catch(() => Taro.showToast({ title: '菜品不存在', icon: 'none' })).finally(() => setLoaded(true))
  }, [id, storeId])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))
  const refreshSort = (items: LocalMedia[]) => items.map((item, sort) => ({ ...item, sort }))

  /**
   * 切换「单菜 / 套餐」。
   * ★ 切回单菜会**连价格和明细一起清掉**（服务端也会清）。这是刻意的，所以必须**先问一句** ——
   *   否则用户点了「单菜」看一眼再切回来，辛苦配好的 5 样菜和套餐价就没了，且无法撤销。
   *   正向切换（单菜 → 套餐）不需要确认：那边没有任何东西会被丢。
   */
  const onKindChange = async (next: DishKind) => {
    if (next === form.kind) return
    const hasComboData = !!form.price.trim() || !!form.originalPrice.trim() || form.combo.length > 0
    if (next === 'SINGLE' && hasComboData) {
      const r = await Taro.showModal({
        title: '改成单菜？',
        content: '套餐价、原价和已挑选的菜品会被清空，改回套餐时需要重新填写。',
        confirmText: '改成单菜',
        confirmColor: '#e1251b',
      })
      if (!r.confirm) return
      setForm((f) => ({ ...f, kind: next, price: '', originalPrice: '', combo: [] }))
      return
    }
    set('kind', next)
  }

  const togglePick = (d: DishItem) => {
    setForm((f) => {
      const hit = f.combo.some((p) => p.dishId === d.id)
      return { ...f, combo: hit ? f.combo.filter((p) => p.dishId !== d.id) : [...f.combo, { dishId: d.id, name: d.name, quantity: 1 }] }
    })
  }
  /**
   * 改份数。
   * ★ 下限是 1 而不是 0：把份数调到 0 等价于「不要这一样」，
   *   让它在这里消失会让用户以为菜没了、又回去重新勾 —— 想取消就点一下行本身。
   */
  const setQuantity = (dishId: string, delta: number) => {
    setForm((f) => ({
      ...f,
      combo: f.combo.map((p) => (p.dishId === dishId ? { ...p, quantity: Math.min(99, Math.max(1, p.quantity + delta)) } : p)),
    }))
  }

  const pickImage = async () => {
    if (uploading) return; const remaining = 3 - form.images.length; if (remaining <= 0) { Taro.showToast({ title: '图片最多上传 3 个', icon: 'none' }); return }; setUploading(true)
    try { const r = await Taro.chooseImage({ count: remaining, sizeType: ['compressed'], sourceType: ['album', 'camera'] }); const next = [...form.images]; for (const file of r.tempFiles) { const asset = await uploadMediaFile({ filePath: file.path, storeId, type: 'IMAGE', sizeBytes: file.size }); const preview = await getDishMediaUrl(asset.cosKey); next.push({ type: 'IMAGE', cosKey: asset.cosKey, sort: next.length, url: preview.url || '' }) }; set('images', refreshSort(next)); Taro.showToast({ title: '图片已上传', icon: 'success' }) } catch { Taro.showToast({ title: '图片上传失败', icon: 'none' }) } finally { setUploading(false) }
  }
  const pickVideo = async () => {
    if (uploading) return; const remaining = 3 - form.videos.length; if (remaining <= 0) { Taro.showToast({ title: '视频最多上传 3 个', icon: 'none' }); return }; setUploading(true)
    try { const r = await Taro.chooseMedia({ count: remaining, mediaType: ['video'], sourceType: ['album', 'camera'], maxDuration: 60 }); const next = [...form.videos]; for (const file of r.tempFiles) { const asset = await uploadMediaFile({ filePath: file.tempFilePath, storeId, type: 'VIDEO', durationMs: file.duration ? file.duration * 1000 : undefined, sizeBytes: file.size }); const preview = await getDishMediaUrl(asset.cosKey); next.push({ type: 'VIDEO', cosKey: asset.cosKey, sort: next.length, url: preview.url || '' }) }; set('videos', refreshSort(next)); Taro.showToast({ title: '视频已上传', icon: 'success' }) } catch { Taro.showToast({ title: '视频上传失败', icon: 'none' }) } finally { setUploading(false) }
  }
  const removeImage = (index: number) => set('images', refreshSort(form.images.filter((_, i) => i !== index)))
  const removeVideo = (index: number) => set('videos', refreshSort(form.videos.filter((_, i) => i !== index)))
  // ★ 与 pages/dish/detail.tsx 是同一处坑：被点的那张必须排到 urls[0]。
  // previewImage 的 current 只收「图片链接」、靠能在 urls 里精确匹配到来定位；
  // 匹配不上（或平台实现忽略 current）时会静默回落到 urls[0]，
  // 表现就是「点第 2、3 张却从第 1 张开始」。
  // 另外这里 urls 是过滤掉上传失败（url 为空）的那些之后的，下标本来就与
  // form.images 对不齐 —— 所以先定位再重排，不拿 index 去猜。
  const previewImages = (index: number) => {
    const cur = form.images[index]?.url
    if (!cur) return
    const urls = form.images.map((m) => m.url).filter(Boolean)
    const at = urls.indexOf(cur)
    if (at < 0) return
    Taro.previewImage({ current: urls[at], urls: [urls[at], ...urls.slice(0, at), ...urls.slice(at + 1)] })
  }

  const onSubmit = async () => {
    if (!form.name.trim()) { Taro.showToast({ title: '请填写名称', icon: 'none' }); return }
    if (!storeId) { Taro.showToast({ title: '缺少门店参数', icon: 'none' }); return }
    if (saving || uploading) return

    const isCombo = form.kind === 'COMBO'
    let priceFen: number | undefined
    let originalPriceFen: number | null | undefined
    if (isCombo) {
      const p = yuanToFen(form.price)
      // ★ 在**前端**先拦一道：服务端也会拒，但用户要等一个网络来回才看到提示，
      //   而这几条都是他自己能在屏幕上核对的事实。
      if (p === null || p <= 0) { Taro.showToast({ title: '请填写套餐价', icon: 'none' }); return }
      if (form.combo.length === 0) { Taro.showToast({ title: '套餐至少要选 1 道菜', icon: 'none' }); return }
      const orig = form.originalPrice.trim() ? yuanToFen(form.originalPrice) : null
      if (form.originalPrice.trim() && (orig === null || orig <= p)) { Taro.showToast({ title: '原价需要高于套餐价', icon: 'none' }); return }
      priceFen = p
      // ★ 空 → null（显式清空划线价），而不是 undefined（= 没提这件事）。
      //   传 undefined 的话，用户把原价删掉再保存，原价会在服务端被沿用回来 —— 删不掉。
      originalPriceFen = orig
    }

    setSaving(true)
    const media = [...form.images, ...form.videos].map((m) => ({ type: m.type, cosKey: m.cosKey, coverKey: m.coverKey, sort: m.sort }))
    const payload: DishInput = {
      name: form.name.trim(),
      intro: form.intro || undefined,
      sellingPoints: form.sellingPoints || undefined,
      coverKey: form.images[0]?.cosKey,
      videoKey: form.videos[0]?.cosKey,
      media,
      kind: form.kind,
      ...(isCombo ? {
        priceFen,
        originalPriceFen,
        comboItems: form.combo.map((p, i) => ({ dishId: p.dishId, quantity: p.quantity, sort: i })),
      } : {}),
    }
    try { if (id) await updateDish(storeId, id, payload); else await createDish(storeId, payload); Taro.showToast({ title: '已保存', icon: 'success' }); Taro.navigateBack() } catch { /* request layer */ } finally { setSaving(false) }
  }

  if (!loaded) return <View className='dish-edit dish-edit--loading'>加载中…</View>
  // 坏编号：既不能请求，也不能退化成「新建」（那会凭空多出一道菜）。唯一的真出路是回列表重进。
  if (idBroken) return <View className='dish-edit dish-edit--loading'>链接里的菜品编号有误，继续保存会新建出一道新菜品。请回到菜品列表重新进入。</View>

  const isCombo = form.kind === 'COMBO'
  const noun = isCombo ? '套餐' : '菜品'
  return <View className='dish-edit'><View className='dish-edit__form'>
    {/* 类型放最前面：它决定了下面出现哪些字段，排在末尾的话用户会先填一堆再发现填错了地方 */}
    <View className='field'><Text className='field__label'>类型</Text>
      <Segmented
        options={[{ value: 'SINGLE', label: '单菜' }, { value: 'COMBO', label: '套餐' }]}
        value={form.kind}
        onChange={(v) => void onKindChange(v as DishKind)}
      />
      <Text className='field__hint'>{isCombo ? '套餐由本门店已有的单菜组成，创作时可直接选用' : '一道独立的菜，可以单独被选进创作'}</Text>
    </View>
    <View className='field'><Text className='field__label'>{noun}图片（最多 3 张）</Text><View className='media-grid'>{form.images.map((m, index) => <View className='media-card' key={m.cosKey}>{m.url ? <Image className='media-card__image' src={m.url} mode='aspectFill' onClick={() => previewImages(index)} /> : <View className='media-card__placeholder'>图片</View>}{index === 0 && <Text className='media-card__cover'>封面</Text>}<Text className='media-card__remove' onClick={() => removeImage(index)}>删除</Text></View>)}{form.images.length < 3 && <View className='media__button media__button--add' onClick={pickImage}>{uploading ? '上传中…' : '+ 图片'}</View>}</View><Text className='field__hint'>第一张图片自动作为{noun}封面</Text></View>
    <View className='field'><Text className='field__label'>{noun}视频（最多 3 个）</Text><View className='media-grid'>{form.videos.map((m, index) => <View className='media-card media-card--video' key={m.cosKey}>{m.url ? <Video className='media-card__video' src={m.url} controls={false} showCenterPlayBtn={false} /> : <View className='media-card__placeholder'>视频</View>}<Text className='media-card__play'>视频 {index + 1}</Text><Text className='media-card__remove' onClick={() => removeVideo(index)}>删除</Text></View>)}{form.videos.length < 3 && <View className='media__button media__button--add' onClick={pickVideo}>{uploading ? '上传中…' : '+ 视频'}</View>}</View></View>
    <View className='field'><Text className='field__label'>{noun}名称<Text className='field__req'>*</Text></Text><Input className='field__input' placeholder={isCombo ? '如：双人套餐' : '如：秘制烤羊排'} value={form.name} onInput={(e) => set('name', e.detail.value)} maxlength={128} /></View>

    {isCombo && (
      <>
        <View className='field'><Text className='field__label'>套餐价（元）<Text className='field__req'>*</Text></Text><Input className='field__input' type='digit' placeholder='如：88' value={form.price} onInput={(e) => set('price', e.detail.value)} maxlength={10} /></View>
        <View className='field'><Text className='field__label'>原价（元）</Text><Input className='field__input' type='digit' placeholder='选填。填了就在套餐价旁边划一条线' value={form.originalPrice} onInput={(e) => set('originalPrice', e.detail.value)} maxlength={10} /><Text className='field__hint'>必须高于套餐价；留空表示不显示划线价</Text></View>
        <View className='field'>
          <Text className='field__label'>套餐内容<Text className='field__req'>*</Text></Text>
          {candidatesFailed && (
            <View className='combo-hint' onClick={() => { setCandidatesFailed(false); if (storeId) void listDishes(storeId).then((all) => setCandidates(all.filter((d) => d.kind !== 'COMBO'))).catch(() => setCandidatesFailed(true)) }}>可选菜品加载失败，点这里重试</View>
          )}
          {!candidatesFailed && candidates.length === 0 && (
            <View className='combo-hint'>这家门店还没有单菜。套餐由单菜组成，请先添加几道菜再回来配套餐。</View>
          )}
          {!candidatesFailed && candidates.length > 0 && (
            <View className='combo-picker'>
              {candidates.map((d) => {
                const pick = form.combo.find((p) => p.dishId === d.id)
                return (
                  <View key={d.id} className={'combo-row' + (pick ? ' combo-row--on' : '')} onClick={() => togglePick(d)}>
                    <Text className='combo-row__tick'>{pick ? '✓' : ''}</Text>
                    <Text className='combo-row__name'>{d.name}</Text>
                    {pick && (
                      <View className='combo-row__qty' onClick={(e) => e.stopPropagation()}>
                        <Text className='combo-row__btn' onClick={() => setQuantity(d.id, -1)}>−</Text>
                        <Text className='combo-row__num'>{pick.quantity}</Text>
                        <Text className='combo-row__btn' onClick={() => setQuantity(d.id, 1)}>+</Text>
                      </View>
                    )}
                  </View>
                )
              })}
            </View>
          )}
          {form.combo.length > 0 && <Text className='field__hint'>已选 {form.combo.length} 样，合计 {form.combo.reduce((s, p) => s + p.quantity, 0)} 份</Text>}
        </View>
      </>
    )}

    <View className='field'><Text className='field__label'>卖点</Text><Textarea className='field__textarea' placeholder='如：外焦里嫩 / 老板秘制蘸料（可换行）' value={form.sellingPoints} onInput={(e) => set('sellingPoints', e.detail.value)} maxlength={1000} autoHeight /></View>
    <View className='field'><Text className='field__label'>简介</Text><Textarea className='field__textarea' placeholder={isCombo ? '一句话说明这个套餐适合几个人吃（可换行）' : '一句话介绍这道菜（可换行）'} value={form.intro} onInput={(e) => set('intro', e.detail.value)} maxlength={500} autoHeight /></View>
  </View><View className='dish-edit__footer'><View className={'dish-edit__save ' + ((saving || uploading) ? 'dish-edit__save--disabled' : '')} onClick={onSubmit}><Text>{id ? '保存修改' : (isCombo ? '添加套餐' : '添加菜品')}</Text></View></View></View>
}
