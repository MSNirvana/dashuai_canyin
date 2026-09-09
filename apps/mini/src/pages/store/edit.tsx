import { useEffect, useState } from 'react'
import { View, Text, Input, Textarea, Switch, Picker } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useRouter } from '@tarojs/taro'
import { createStore, updateStore, getStore, type StoreInput, type StoreItem } from '../../services/store'
import './edit.scss'

interface FormState {
  name: string
  category: string
  city: string
  district: string
  address: string
  contact: string
  isDefault: boolean
}

const EMPTY: FormState = {
  name: '',
  category: '',
  city: '',
  district: '',
  address: '',
  contact: '',
  isDefault: false,
}

const CITY_OPTIONS = [
  { city: '北京', districts: ['东城区', '西城区', '朝阳区', '海淀区', '丰台区', '石景山区', '通州区', '大兴区', '昌平区'] },
  { city: '上海', districts: ['黄浦区', '徐汇区', '长宁区', '静安区', '普陀区', '虹口区', '杨浦区', '浦东新区', '闵行区'] },
  { city: '广州', districts: ['越秀区', '海珠区', '荔湾区', '天河区', '白云区', '黄埔区', '番禺区', '花都区'] },
  { city: '深圳', districts: ['福田区', '罗湖区', '南山区', '宝安区', '龙岗区', '龙华区', '坪山区', '光明区'] },
  { city: '杭州', districts: ['上城区', '拱墅区', '西湖区', '滨江区', '萧山区', '余杭区', '临平区', '钱塘区'] },
  { city: '成都', districts: ['锦江区', '青羊区', '金牛区', '武侯区', '成华区', '龙泉驿区', '温江区', '双流区'] },
  { city: '重庆', districts: ['渝中区', '江北区', '南岸区', '九龙坡区', '沙坪坝区', '渝北区', '巴南区', '北碚区'] },
  { city: '武汉', districts: ['江岸区', '江汉区', '硚口区', '汉阳区', '武昌区', '青山区', '洪山区', '东西湖区'] },
  { city: '西安', districts: ['新城区', '碑林区', '莲湖区', '雁塔区', '未央区', '灞桥区', '长安区'] },
  { city: '长沙', districts: ['芙蓉区', '天心区', '岳麓区', '开福区', '雨花区', '望城区', '长沙县'] },
]

export default function StoreEditPage() {
  const router = useRouter()
  const id = router.params.id
  const [form, setForm] = useState<FormState>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!id) {
      setLoaded(true)
      return
    }
    getStore(id)
      .then((s: StoreItem) => {
        setForm({
          name: s.name,
          category: s.category ?? '',
          city: s.city ?? '',
          district: s.district ?? '',
          address: s.address ?? '',
          contact: s.contact ?? '',
          isDefault: s.isDefault,
        })
      })
      .catch(() => {
        Taro.showToast({ title: '门店不存在', icon: 'none' })
      })
      .finally(() => setLoaded(true))
  }, [id])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const cityNames = CITY_OPTIONS.map((o) => o.city)
  const cityIndex = Math.max(0, cityNames.indexOf(form.city))
  const districtOptions = CITY_OPTIONS[cityIndex]?.districts ?? []
  const districtIndex = Math.max(0, districtOptions.indexOf(form.district))

  const onSubmit = async () => {
    if (!form.name.trim()) {
      Taro.showToast({ title: '请填写门店名称', icon: 'none' })
      return
    }
    setSaving(true)
    const payload: StoreInput = {
      name: form.name.trim(),
      category: form.category || undefined,
      city: form.city || undefined,
      district: form.district || undefined,
      address: form.address || undefined,
      contact: form.contact || undefined,
      isDefault: form.isDefault || undefined,
    }
    try {
      if (id) await updateStore(id, payload)
      else await createStore(payload)
      Taro.showToast({ title: '已保存', icon: 'success' })
      Taro.navigateBack()
    } catch {
      /* 错误已 toast */
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return <View className='store-edit store-edit--loading'>加载中…</View>

  return (
    <View className='store-edit'>
      <View className='store-edit__form'>
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

        <View className='field field--row'>
          <View className='field__col'>
            <Text className='field__label'>城市</Text>
            <Picker mode='selector' range={cityNames} value={cityIndex} onChange={(e) => set('city', cityNames[Number(e.detail.value)] ?? '')}>
              <View className='field__picker'>{form.city || '选择城市'}</View>
            </Picker>
          </View>
          <View className='field__col'>
            <Text className='field__label'>区县</Text>
            <Picker mode='selector' range={districtOptions} value={districtIndex} onChange={(e) => set('district', districtOptions[Number(e.detail.value)] ?? '')}>
              <View className='field__picker'>{form.district || '选择区县'}</View>
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
