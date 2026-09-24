import { useEffect, useRef, useState } from 'react'
import { View, Text, Textarea } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { getPersona, savePersona, type PersonaItem } from '../../services/persona'
import { useMerchantStore } from '../../store/merchant'
import StoreSwitcher from '../../components/store-switcher'
// 时间统一走 utils/time：原来用 toLocaleString('zh-CN')，出来是「2026/9/18 10:59:39」（斜杠 + 秒）
import { formatMinute } from '../../utils/time'
import './index.scss'

const VOICE_PRESETS = ['热情实在', '专业懂行', '幽默接地气', '温柔耐心', '爽快直接', '匠人型老板']

/** 门店级人设（跟随左上角当前门店切换，标签按行输入即可） */
export default function PersonaPage() {
  const currentStoreId = useMerchantStore((s) => s.currentStoreId)
  const stores = useMerchantStore((s) => s.stores)
  const loadStores = useMerchantStore((s) => s.loadStores)
  const [form, setForm] = useState<{ bossTags: string; activity: string }>({ bossTags: '', activity: '' })
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  /**
   * 当前表单内容属于哪家门店。只接受「最新一次请求」的响应还不够 ——
   * 保存时也要再比一次：切店后旧店的慢响应若覆盖表单，用户一点保存，
   * 就把 A 店的人设写进了 B 店（savePersona 按 currentStoreId 落库）。
   */
  const [formStoreId, setFormStoreId] = useState('')
  /**
   * 加载是否**真失败**。服务端对「没记录」返回 200 + 空值（走 then），
   * 能进 catch 的都是网络/接口错误 —— 绝不能当空表单展示，否则用户一保存
   * 就把库里真实的人设覆盖成空白。
   */
  const [loadFailed, setLoadFailed] = useState(false)
  /** 请求代次：切店/重进并发时，只认最后一次请求的响应 */
  const reqRef = useRef(0)

  const load = () => {
    // 无门店：引导去建店（人设挂在门店下）
    if (!currentStoreId) {
      setForm({ bossTags: '', activity: '' })
      setUpdatedAt(null)
      setFormStoreId('')
      setLoadFailed(false)
      setLoaded(true)
      return
    }
    const sid = currentStoreId
    const my = ++reqRef.current
    setLoaded(false)
    setLoadFailed(false)
    getPersona(sid)
      .then((p: PersonaItem) => {
        if (my !== reqRef.current) return
        setForm({ bossTags: p.bossTags ?? '', activity: p.activity ?? '' })
        setUpdatedAt(p.updatedAt)
        setFormStoreId(sid)
      })
      .catch(() => {
        if (my !== reqRef.current) return
        setLoadFailed(true)
      })
      .finally(() => {
        if (my === reqRef.current) setLoaded(true)
      })
  }

  useEffect(() => {
    Taro.setNavigationBarTitle({ title: '老板人设' })
  }, [])

  useDidShow(() => {
    void loadStores().catch(() => undefined)
    load()
  })

  // 门店切换后立即重载（首次挂载由 useDidShow 负责，避免重复请求）
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false
      return
    }
    load()
  }, [currentStoreId])

  const set = <K extends 'bossTags' | 'activity'>(k: K, v: string) => setForm((f) => ({ ...f, [k]: v }))

  const applyVoice = (voice: string) => {
    const tags = form.bossTags.split(/[\/,，、]/).map((item) => item.trim()).filter(Boolean)
    if (!tags.includes(voice)) set('bossTags', [...tags, voice].join(' / '))
  }

  const previewVoice = form.bossTags.trim() || '热情实在的老板'
  const previewActivity = form.activity.trim() || '今天到店的朋友，可以试试我们的招牌菜。'

  const onSave = async () => {
    if (!currentStoreId) {
      Taro.showToast({ title: '请先选择门店（左上角）', icon: 'none' })
      return
    }
    if (loadFailed) {
      Taro.showToast({ title: '加载失败的内容不能保存，请重新加载', icon: 'none' })
      return
    }
    // 表单内容必须是**当前门店**的（见 formStoreId 的说明）：挡住「切店后旧响应覆盖表单」
    if (formStoreId !== currentStoreId) {
      Taro.showToast({ title: '正在加载当前门店的人设，请稍候再保存', icon: 'none' })
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

  const storeName = stores.find((s) => s.id === currentStoreId)?.name || ''

  const bar = (
    <View className='persona__bar'>
      <StoreSwitcher />
      {storeName && <Text className='persona__barhint'>人设归属该门店</Text>}
    </View>
  )

  if (!loaded) return <View className='persona persona--loading'>加载中…</View>

  if (loadFailed) {
    return (
      <View className='persona persona--loading'>
        <Text>人设加载失败，请检查网络</Text>
        <View className='persona__save' onClick={() => load()}><Text>重新加载</Text></View>
      </View>
    )
  }

  if (!currentStoreId) return <View className='persona'>
    {bar}
    <View className='persona__intro'>
        <Text className='persona__eyebrow'>BRAND VOICE</Text>
        <Text className='persona__title'>先创建你的门店</Text>
        <Text className='persona__sub'>有了门店资料，才能让每条视频说出属于你的语气。</Text>
    </View>
    <View className='persona__footer'>
      <View className='persona__save' onClick={() => Taro.navigateTo({ url: '/pages/store/list' })}><Text>去建店</Text></View>
    </View>
  </View>

  return (
    <View className='persona'>
      {bar}
      <View className='persona__intro'>
        <Text className='persona__eyebrow'>BRAND VOICE</Text>
        <Text className='persona__title'>让顾客记住你的店</Text>
        <Text className='persona__sub'>把老板的性格、故事和门店活动，变成每条视频里自然说出来的话。</Text>
      </View>

      <View className='persona__voice-card'>
        <View className='persona__voice-head'>
          <View>
            <Text className='persona__voice-kicker'>先选一种感觉</Text>
            <Text className='persona__voice-title'>你希望顾客怎样记住老板？</Text>
          </View>
          <Text className='persona__voice-mark'>01</Text>
        </View>
        <View className='persona__presets'>
          {VOICE_PRESETS.map((voice) => {
            const active = form.bossTags.includes(voice)
            return <View key={voice} className={`persona__preset ${active ? 'persona__preset--active' : ''}`} onClick={() => applyVoice(voice)}>{voice}</View>
          })}
        </View>
      </View>

      <View className='persona__form'>
        <View className='field'>
          <Text className='field__step'>02</Text>
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
          <Text className='field__step'>03</Text>
          <Text className='field__label'>最近想重点告诉顾客什么</Text>
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

      <View className='persona__preview'>
        <View className='persona__preview-head'>
          <Text className='persona__preview-kicker'>PREVIEW</Text>
          <Text className='persona__preview-label'>生成出来的语气会像这样</Text>
        </View>
        <Text className='persona__preview-copy'>“{previewActivity} 我是{previewVoice}的老板，欢迎来店里坐坐。”</Text>
      </View>

      {updatedAt && (
        <View className='persona__meta'>
          <Text>最近更新：{formatMinute(updatedAt)}</Text>
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
