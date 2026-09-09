import { useEffect, useState } from 'react'
import { View, Text, Input, Textarea } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { createDish, updateDish, getDish, type DishInput, type DishItem } from '../../services/dish'
import { uploadMediaFile } from '../../services/upload'
import './edit.scss'

interface FormState {
  name: string
  intro: string
  sellingPoints: string
  coverKey: string
  videoKey: string
}

const EMPTY: FormState = { name: '', intro: '', sellingPoints: '', coverKey: '', videoKey: '' }

export default function DishEditPage() {
  const router = useRouter()
  const storeId = router.params.storeId ?? ''
  const id = router.params.id
  const [form, setForm] = useState<FormState>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [uploadingVideo, setUploadingVideo] = useState(false)

  useEffect(() => {
    if (!id) {
      setLoaded(true)
      return
    }
    getDish(storeId, id)
      .then((d: DishItem) => {
        setForm({ name: d.name, intro: d.intro ?? '', sellingPoints: d.sellingPoints ?? '', coverKey: d.coverKey ?? '', videoKey: d.videoKey ?? '' })
      })
      .catch(() => Taro.showToast({ title: '菜品不存在', icon: 'none' }))
      .finally(() => setLoaded(true))
  }, [id, storeId])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const pickImage = async () => {
    if (uploadingImage || uploadingVideo) return
    setUploadingImage(true)
    try {
      const r = await Taro.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'] })
      const file = r.tempFiles[0]
      if (!file) return
      const asset = await uploadMediaFile({ filePath: file.path, storeId, type: 'IMAGE', sizeBytes: file.size })
      set('coverKey', asset.cosKey)
      Taro.showToast({ title: '图片已上传', icon: 'success' })
    } catch {
      Taro.showToast({ title: '图片上传失败', icon: 'none' })
    } finally {
      setUploadingImage(false)
    }
  }

  const pickVideo = async () => {
    if (uploadingImage || uploadingVideo) return
    setUploadingVideo(true)
    try {
      const r = await Taro.chooseMedia({ count: 1, mediaType: ['video'], sourceType: ['album', 'camera'], maxDuration: 60 })
      const file = r.tempFiles[0]
      if (!file) return
      const asset = await uploadMediaFile({
        filePath: file.tempFilePath,
        storeId,
        type: 'VIDEO',
        durationMs: file.duration ? file.duration * 1000 : undefined,
        sizeBytes: file.size,
      })
      set('videoKey', asset.cosKey)
      Taro.showToast({ title: '视频已上传', icon: 'success' })
    } catch {
      Taro.showToast({ title: '视频上传失败', icon: 'none' })
    } finally {
      setUploadingVideo(false)
    }
  }

  const onSubmit = async () => {
    if (!form.name.trim()) {
      Taro.showToast({ title: '请填写菜品名称', icon: 'none' })
      return
    }
    if (!storeId) {
      Taro.showToast({ title: '缺少门店参数', icon: 'none' })
      return
    }
    setSaving(true)
    const payload: DishInput = {
      name: form.name.trim(),
      intro: form.intro || undefined,
      sellingPoints: form.sellingPoints || undefined,
      coverKey: form.coverKey || undefined,
      videoKey: form.videoKey || undefined,
    }
    try {
      if (id) await updateDish(storeId, id, payload)
      else await createDish(storeId, payload)
      Taro.showToast({ title: '已保存', icon: 'success' })
      Taro.navigateBack()
    } catch {
      /* 错误已 toast */
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return <View className='dish-edit dish-edit--loading'>加载中…</View>

  return (
    <View className='dish-edit'>
      <View className='dish-edit__form'>
        <View className='field'>
          <Text className='field__label'>菜品图片</Text>
          <View className={`media__button ${uploadingImage ? 'media__button--busy' : ''}`} onClick={pickImage}>
            {form.coverKey ? '已上传图片 · 点击更换' : '上传图片'}
          </View>
        </View>
        <View className='field'>
          <Text className='field__label'>菜品视频</Text>
          <View className={`media__button ${uploadingVideo ? 'media__button--busy' : ''}`} onClick={pickVideo}>
            {form.videoKey ? '已上传视频 · 点击更换' : '上传视频'}
          </View>
        </View>
        <View className='field'>
          <Text className='field__label'>菜品名称<Text className='field__req'>*</Text></Text>
          <Input
            className='field__input'
            placeholder='如：秘制烤羊排'
            value={form.name}
            onInput={(e) => set('name', e.detail.value)}
            maxlength={128}
          />
        </View>

        <View className='field'>
          <Text className='field__label'>卖点</Text>
          <Textarea
            className='field__textarea'
            placeholder='如：外焦里嫩 / 老板秘制蘸料（可换行）'
            value={form.sellingPoints}
            onInput={(e) => set('sellingPoints', e.detail.value)}
            maxlength={1000}
            autoHeight
          />
        </View>

        <View className='field'>
          <Text className='field__label'>简介</Text>
          <Textarea
            className='field__textarea'
            placeholder='一句话介绍这道菜（可换行）'
            value={form.intro}
            onInput={(e) => set('intro', e.detail.value)}
            maxlength={500}
            autoHeight
          />
        </View>
      </View>

      <View className='dish-edit__footer'>
        <View className={`dish-edit__save ${saving ? 'dish-edit__save--disabled' : ''}`} onClick={onSubmit}>
          <Text>{id ? '保存修改' : '添加菜品'}</Text>
        </View>
      </View>
    </View>
  )
}
