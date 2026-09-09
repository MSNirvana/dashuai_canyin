import { useEffect, useState } from 'react'
import { View, Text, Input, Textarea, Switch, Picker, Image } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useRouter } from '@tarojs/taro'
import { createStore, updateStore, getStore, getStoreCoverUrl, type StoreInput, type StoreItem } from '../../services/store'
import { uploadMediaFile } from '../../services/upload'
import { cityOptions, districtOptions, provinceOptions, resolveAreaNames } from '../../services/area'
import './edit.scss'

interface FormState {
  name: string
  category: string
  province: string
  city: string
  district: string
  address: string
  contact: string
  isDefault: boolean
  coverKey: string
}

const EMPTY: FormState = {
  name: '',
  category: '',
  province: '',
  city: '',
  district: '',
  address: '',
  contact: '',
  isDefault: false,
  coverKey: '',
}

export default function StoreEditPage() {
  const router = useRouter()
  const id = router.params.id
  const [form, setForm] = useState<FormState>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pendingImage, setPendingImage] = useState<{ path: string; size: number } | null>(null)
  const [coverPreview, setCoverPreview] = useState('')

  useEffect(() => {
    if (!id) {
      setLoaded(true)
      return
    }
    getStore(id)
      .then((s: StoreItem) => {
        const area = resolveAreaNames(s)
        setForm({
          name: s.name,
          category: s.category ?? '',
          province: area.province,
          city: area.city,
          district: area.district,
          address: s.address ?? '',
          contact: s.contact ?? '',
          isDefault: s.isDefault,
          coverKey: s.coverKey ?? '',
        })
        if (s.coverKey) {
          getStoreCoverUrl(s.coverKey).then((r) => setCoverPreview(r.url ?? '')).catch(() => undefined)
        }
      })
      .catch(() => {
        Taro.showToast({ title: '门店不存在', icon: 'none' })
      })
      .finally(() => setLoaded(true))
  }, [id])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const provinceIndex = Math.max(0, provinceOptions.findIndex((o) => o.name === form.province))
  const provinceCode = provinceOptions[provinceIndex]?.code ?? ''
  const cities = cityOptions(provinceCode)
  const cityIndex = Math.max(0, cities.findIndex((o) => o.name === form.city))
  const cityCode = cities[cityIndex]?.code ?? ''
  const districts = districtOptions(cityCode)
  const districtIndex = Math.max(0, districts.findIndex((o) => o.name === form.district))

  const pickImage = async () => {
    if (saving) return
    try {
      const r = await Taro.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'] })
      const file = r.tempFiles[0]
      if (!file) return
      setPendingImage({ path: file.path, size: file.size })
      setCoverPreview(file.path)
      set('coverKey', '')
    } catch {
      // 用户取消选择时不提示错误
    }
  }

  const removeImage = () => {
    setPendingImage(null)
    setCoverPreview('')
    set('coverKey', '')
  }

  const onSubmit = async () => {
    if (saving) return
    if (!form.name.trim()) {
      Taro.showToast({ title: '请填写门店名称', icon: 'none' })
      return
    }
    setSaving(true)
    let storeId = id
    let uploadedCoverKey = form.coverKey || null
    try {
      const basePayload: StoreInput = {
        name: form.name.trim(),
        category: form.category || undefined,
        province: form.province || undefined,
        city: form.city || undefined,
        district: form.district || undefined,
        address: form.address || undefined,
        contact: form.contact || undefined,
        isDefault: form.isDefault || undefined,
      }
      if (storeId) {
        if (pendingImage) {
          const asset = await uploadMediaFile({ filePath: pendingImage.path, storeId, type: 'IMAGE', sizeBytes: pendingImage.size })
          uploadedCoverKey = asset.cosKey
        }
        await updateStore(storeId, { ...basePayload, coverKey: uploadedCoverKey })
      } else {
        const created = await createStore(basePayload)
        storeId = created.id
        if (pendingImage) {
          const asset = await uploadMediaFile({ filePath: pendingImage.path, storeId, type: 'IMAGE', sizeBytes: pendingImage.size })
          await updateStore(storeId, { ...basePayload, coverKey: asset.cosKey })
        }
      }
      Taro.showToast({ title: '已保存', icon: 'success' })
      Taro.navigateBack()
    } catch {
      if (!id && storeId) {
        Taro.showToast({ title: '门店已创建，图片保存失败', icon: 'none' })
        Taro.navigateBack()
      }
      else Taro.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return <View className='store-edit store-edit--loading'>加载中…</View>

  return (
    <View className='store-edit'>
      <View className='store-edit__form'>
        <View className='field'>
          <Text className='field__label'>门店图片</Text>
          {coverPreview ? (
            <View className='store-cover'>
              <Image className='store-cover__image' src={coverPreview} mode='aspectFill' />
              <View className='store-cover__actions'>
                <View className='store-cover__action' onClick={pickImage}>更换</View>
                <View className='store-cover__action store-cover__action--danger' onClick={removeImage}>删除</View>
              </View>
            </View>
          ) : (
            <View className='store-cover store-cover--empty' onClick={pickImage}>
              <Text>上传门店主图</Text>
            </View>
          )}
        </View>

        <View className='field'>
          <Text className='field__label'>门店名称<Text className='field__req'>*</Text></Text>
          <Input
            className='field__input'
            placeholder='如：大帅烧烤（中关村店）'
            value={form.name}
            onInput={(e) => set('name', e.detail.value)}
            maxlength={128}
          />
        </View>

        <View className='field'>
          <Text className='field__label'>品类</Text>
          <Input
            className='field__input'
            placeholder='如：烧烤 / 火锅 / 川菜'
            value={form.category}
            onInput={(e) => set('category', e.detail.value)}
            maxlength={64}
          />
        </View>

        <View className='field field--region'>
          <View className='field__col'>
            <Text className='field__label'>省/地区</Text>
            <Picker mode='selector' range={provinceOptions.map((o) => o.name)} value={provinceIndex} onChange={(e) => {
              const next = provinceOptions[Number(e.detail.value)]
              const nextCities = cityOptions(next?.code ?? '')
              const nextCity = nextCities[0]
              const nextDistrict = nextCity ? districtOptions(nextCity.code)[0] : undefined
              setForm((f) => ({ ...f, province: next?.name ?? '', city: nextCity?.name ?? '', district: nextDistrict?.name ?? '' }))
            }}>
              <View className='field__picker'>{form.province || '选择省/地区'}</View>
            </Picker>
          </View>
          <View className='field__col'>
            <Text className='field__label'>城市</Text>
            <Picker disabled={!form.province} mode='selector' range={cities.map((o) => o.name)} value={cityIndex} onChange={(e) => {
              const nextCity = cities[Number(e.detail.value)]
              const nextDistrict = nextCity ? districtOptions(nextCity.code)[0] : undefined
              setForm((f) => ({ ...f, city: nextCity?.name ?? '', district: nextDistrict?.name ?? '' }))
            }}>
              <View className={`field__picker ${!form.province ? 'field__picker--disabled' : ''}`}>{form.city || '请先选择省/地区'}</View>
            </Picker>
          </View>
          <View className='field__col'>
            <Text className='field__label'>区县</Text>
            <Picker disabled={!form.city} mode='selector' range={districts.map((o) => o.name)} value={districtIndex} onChange={(e) => set('district', districts[Number(e.detail.value)]?.name ?? '')}>
              <View className={`field__picker ${!form.city ? 'field__picker--disabled' : ''}`}>{form.district || (form.city ? '选择区县' : '请先选择城市')}</View>
            </Picker>
          </View>
        </View>

        <View className='field'>
          <Text className='field__label'>详细地址</Text>
          <Textarea
            className='field__textarea'
            placeholder='街道 / 门牌 / 楼栋 / 单元（可换行）'
            value={form.address}
            onInput={(e) => set('address', e.detail.value)}
            maxlength={255}
            autoHeight
          />
        </View>

        <View className='field'>
          <Text className='field__label'>联系电话</Text>
          <Input className='field__input' placeholder='顾客可联系的电话' value={form.contact} onInput={(e) => set('contact', e.detail.value)} maxlength={64} />
        </View>

        <View className='field field--switch'>
          <Text className='field__label'>设为默认门店</Text>
          <Switch checked={form.isDefault} onChange={(e) => set('isDefault', e.detail.value)} color='#e63946' />
        </View>
      </View>

      <View className='store-edit__footer'>
        <View className={`store-edit__save ${saving ? 'store-edit__save--disabled' : ''}`} onClick={onSubmit}>
          <Text>{id ? '保存修改' : '创建门店'}</Text>
        </View>
      </View>
    </View>
  )
}
