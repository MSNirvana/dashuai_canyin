import { useEffect, useState } from 'react'
import { View, Text, Input, Textarea, Image, Video } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { createDish, updateDish, getDish, getDishMediaUrl, type DishInput, type DishItem, type DishMedia } from '../../services/dish'
import { uploadMediaFile } from '../../services/upload'
import { useMerchantStore } from '../../store/merchant'
import './edit.scss'

interface LocalMedia { type: 'IMAGE' | 'VIDEO'; cosKey: string; coverKey?: string; sort: number; url: string; coverUrl?: string }
interface FormState { name: string; intro: string; sellingPoints: string; images: LocalMedia[]; videos: LocalMedia[] }
const EMPTY: FormState = { name: '', intro: '', sellingPoints: '', images: [], videos: [] }

async function toLocalMedia(m: DishMedia): Promise<LocalMedia> {
  const result = await getDishMediaUrl(m.cosKey).catch(() => ({ url: null }))
  let coverUrl = ''
  if (m.coverKey) { try { coverUrl = (await getDishMediaUrl(m.coverKey)).url || '' } catch { /* placeholder */ } }
  return { type: m.type, cosKey: m.cosKey, coverKey: m.coverKey || undefined, sort: m.sort, url: result.url || '', coverUrl }
}

export default function DishEditPage() {
  const router = useRouter(); const { currentStoreId } = useMerchantStore(); const storeId = router.params.storeId ?? currentStoreId; const id = router.params.id
  const [form, setForm] = useState<FormState>(EMPTY); const [loaded, setLoaded] = useState(false); const [saving, setSaving] = useState(false); const [uploading, setUploading] = useState(false)
  useEffect(() => {
    if (!id) { setLoaded(true); return }
    getDish(storeId, id).then(async (d: DishItem) => {
      const legacy: DishMedia[] = d.media?.length ? d.media : [...(d.coverKey ? [{ type: 'IMAGE' as const, cosKey: d.coverKey, sort: 0 }] : []), ...(d.videoKey ? [{ type: 'VIDEO' as const, cosKey: d.videoKey, sort: 0 }] : [])]
      const media = await Promise.all(legacy.map(toLocalMedia))
      setForm({ name: d.name, intro: d.intro || '', sellingPoints: d.sellingPoints || '', images: media.filter((m) => m.type === 'IMAGE'), videos: media.filter((m) => m.type === 'VIDEO') })
    }).catch(() => Taro.showToast({ title: '菜品不存在', icon: 'none' })).finally(() => setLoaded(true))
  }, [id, storeId])
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))
  const refreshSort = (items: LocalMedia[]) => items.map((item, sort) => ({ ...item, sort }))
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
    if (!form.name.trim()) { Taro.showToast({ title: '请填写菜品名称', icon: 'none' }); return }; if (!storeId) { Taro.showToast({ title: '缺少门店参数', icon: 'none' }); return }; if (saving || uploading) return; setSaving(true)
    const media = [...form.images, ...form.videos].map((m) => ({ type: m.type, cosKey: m.cosKey, coverKey: m.coverKey, sort: m.sort })); const payload: DishInput = { name: form.name.trim(), intro: form.intro || undefined, sellingPoints: form.sellingPoints || undefined, coverKey: form.images[0]?.cosKey, videoKey: form.videos[0]?.cosKey, media }
    try { if (id) await updateDish(storeId, id, payload); else await createDish(storeId, payload); Taro.showToast({ title: '已保存', icon: 'success' }); Taro.navigateBack() } catch { /* request layer */ } finally { setSaving(false) }
  }
  if (!loaded) return <View className='dish-edit dish-edit--loading'>加载中…</View>
  return <View className='dish-edit'><View className='dish-edit__form'>
    <View className='field'><Text className='field__label'>菜品图片（最多 3 张）</Text><View className='media-grid'>{form.images.map((m, index) => <View className='media-card' key={m.cosKey}>{m.url ? <Image className='media-card__image' src={m.url} mode='aspectFill' onClick={() => previewImages(index)} /> : <View className='media-card__placeholder'>图片</View>}{index === 0 && <Text className='media-card__cover'>封面</Text>}<Text className='media-card__remove' onClick={() => removeImage(index)}>删除</Text></View>)}{form.images.length < 3 && <View className='media__button media__button--add' onClick={pickImage}>{uploading ? '上传中…' : '+ 上传图片'}</View>}</View><Text className='field__hint'>第一张图片自动作为菜品封面</Text></View>
    <View className='field'><Text className='field__label'>菜品视频（最多 3 个）</Text><View className='media-grid'>{form.videos.map((m, index) => <View className='media-card media-card--video' key={m.cosKey}>{m.url ? <Video className='media-card__video' src={m.url} controls={false} showCenterPlayBtn={false} /> : <View className='media-card__placeholder'>视频</View>}<Text className='media-card__play'>视频 {index + 1}</Text><Text className='media-card__remove' onClick={() => removeVideo(index)}>删除</Text></View>)}{form.videos.length < 3 && <View className='media__button media__button--add' onClick={pickVideo}>{uploading ? '上传中…' : '+ 上传视频'}</View>}</View></View>
    <View className='field'><Text className='field__label'>菜品名称<Text className='field__req'>*</Text></Text><Input className='field__input' placeholder='如：秘制烤羊排' value={form.name} onInput={(e) => set('name', e.detail.value)} maxlength={128} /></View>
    <View className='field'><Text className='field__label'>卖点</Text><Textarea className='field__textarea' placeholder='如：外焦里嫩 / 老板秘制蘸料（可换行）' value={form.sellingPoints} onInput={(e) => set('sellingPoints', e.detail.value)} maxlength={1000} autoHeight /></View>
    <View className='field'><Text className='field__label'>简介</Text><Textarea className='field__textarea' placeholder='一句话介绍这道菜（可换行）' value={form.intro} onInput={(e) => set('intro', e.detail.value)} maxlength={500} autoHeight /></View>
  </View><View className='dish-edit__footer'><View className={'dish-edit__save ' + ((saving || uploading) ? 'dish-edit__save--disabled' : '')} onClick={onSubmit}><Text>{id ? '保存修改' : '添加菜品'}</Text></View></View></View>
}
