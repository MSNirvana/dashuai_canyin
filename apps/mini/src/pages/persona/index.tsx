import { useState } from 'react'
import { View, Text, Textarea } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { getPersona, savePersona, type PersonaItem } from '../../services/persona'
import { useMerchantStore } from '../../store/merchant'
import './index.scss'

/** 门店级人设的纯展示/编辑页（跟随左上角当前门店切换，标签按行输入即可） */
export default function PersonaPage() {
  const { currentStoreId } = useMerchantStore()
  const [form, setForm] = useState<{ bossTags: string; activity: string }>({ bossTags: '', activity: '' })
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)

  useDidShow(() => {
    // 无门店：引导去建店（人设挂在门店下）
    if (!currentStoreId) {
      setLoaded(true)
      return
    }
    setLoaded(false)
    getPersona(currentStoreId)
      .then((p: PersonaItem) => {
        setForm({ bossTags: p.bossTags ?? '', activity: p.activity ?? '' })
        setUpdatedAt(p.updatedAt)
      })
      .catch(() => {
        // 没记录属正常，给空值
        setForm({ bossTags: '', activity: '' })
      })
      .finally(() => setLoaded(true))
  })

  const set = <K extends 'bossTags' | 'activity'>(k: K, v: string) => setForm((f) => ({ ...f, [k]: v }))

  const onSave = async () => {
    if (!currentStoreId) {
      Taro.showToast({ title: '请先选择门店（首页左上角）', icon: 'none' })
      return
    }
    setSaving(true)
    try {
      const r = await savePersona(currentStoreId, {
        bossTags: form.bossTags.trim() ? form.bossTags.trim() : null,
        activity: form.activity.trim() ? form.activity.trim() : null,
      })
      setUpdatedAt(r.updatedAt)
      Taro.showToast({ title: '已保存', icon: 'success' })
    } catch {
      /* toast 已在 request 层 */
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return <View className='persona persona--loading'>加载中…</View>

  if (!currentStoreId) return <View className='persona'>
    <View className='persona__intro'>
      <Text className='persona__title'>老板人设与门店活动</Text>
      <Text className='persona__sub'>还没有门店。先创建一家门店，人设会挂在门店下。</Text>
    </View>
    <View className='persona__footer'>
      <View className='persona__save' onClick={() => Taro.navigateTo({ url: '/pages/store/list' })}><Text>去建店</Text></View>
    </View>
  </View>

  return (
    <View className='persona'>
      <View className='persona__intro'>
        <Text className='persona__title'>老板人设与门店活动</Text>
        <Text className='persona__sub'>这些信息会作为 AI 生成文案与分镜的上下文，越具体输出越贴你。</Text>
      </View>

      <View className='persona__form'>
        <View className='field'>
          <Text className='field__label'>老板人设标签</Text>
          <Textarea
            className='field__textarea'
            placeholder='例如：90后老板 / 退伍军人 / 热爱研发 / 东北豪爽 / 资深吃货 / 创业十年'
            value={form.bossTags}
            onInput={(e) => set('bossTags', e.detail.value)}
            maxlength={500}
            autoHeight
          />
          <Text className='field__hint'>多条用「/」或「,」分隔，500 字以内</Text>
        </View>

        <View className='field'>
          <Text className='field__label'>门店活动</Text>
          <Textarea
            className='field__textarea'
            placeholder='例如：开业酬宾 8 折 / 满 200 减 50 / 老客户送招牌酸梅汤 / 每周三会员日'
            value={form.activity}
            onInput={(e) => set('activity', e.detail.value)}
            maxlength={1000}
            autoHeight
          />
          <Text className='field__hint'>1000 字以内，会参与 AI 文案生成</Text>
        </View>
      </View>

      {updatedAt && (
        <View className='persona__meta'>
          <Text>最近更新：{new Date(updatedAt).toLocaleString('zh-CN')}</Text>
        </View>
      )}

      <View className='persona__footer'>
        <View
          className={`persona__save ${saving ? 'persona__save--disabled' : ''}`}
          onClick={onSave}
        >
          <Text>{saving ? '保存中…' : '保存'}</Text>
        </View>
      </View>
    </View>
  )
}
