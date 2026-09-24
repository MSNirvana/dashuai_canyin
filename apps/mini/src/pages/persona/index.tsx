import { useEffect, useRef, useState } from 'react'
import { View, Text, Textarea } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { getPersona, savePersona, type PersonaItem } from '../../services/persona'
import { useMerchantStore } from '../../store/merchant'
// 时间统一走 utils/time：原来用 toLocaleString('zh-CN')，出来是「2026/9/18 10:59:39」（斜杠 + 秒）
import { formatMinute } from '../../utils/time'
import './index.scss'

const VOICE_PRESETS = ['热情实在', '专业懂行', '幽默接地气', '温柔耐心', '爽快直接', '匠人型老板']

/** 门店级人设（★ 单店模型 2026-09-24：恒等于账号唯一门店，顶上门店切换器已删除） */
export default function PersonaPage() {
  const currentStoreId = useMerchantStore((s) => s.currentStoreId)
  const loadStores = useMerchantStore((s) => s.loadStores)
  const [form, setForm] = useState<{ bossTags: string; activity: string }>({ bossTags: '', activity: '' })
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  /**
   * 当前表单内容属于哪家门店。只接受「最新一次请求」的响应还不够 ——
   * 保存时也要再比一次：旧响应若晚于新请求覆盖表单，用户一点保存，
   * 就把 A 店的人设写进了 B 店（savePersona 按 currentStoreId 落库）。
   * ★ 单店模型（2026-09-24）下「切店」这条路径已不存在，但**重进页面 / 换账号登录**
   *   仍会让两次请求乱序，这道闸门留着依然是对的，不要因为「只有一家店」删掉。
   */
  const [formStoreId, setFormStoreId] = useState('')
  /**
   * 加载是否**真失败**。服务端对「没记录」返回 200 + 空值（走 then），
   * 能进 catch 的都是网络/接口错误 —— 绝不能当空表单展示，否则用户一保存
   * 就把库里真实的人设覆盖成空白。
   */
  const [loadFailed, setLoadFailed] = useState(false)
  /** 请求代次：重进页面 / 换账号并发时，只认最后一次请求的响应 */
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

  // 全局门店变化后立即重载（首次挂载由 useDidShow 负责，避免重复请求）
  // ★ 单店模型下 currentStoreId 只会在「首次拉到门店」时从空变成唯一门店的值，通常只触发一次
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
      Taro.showToast({ title: '请先创建门店', icon: 'none' })
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

  // ★ 2026-09-24 单店模型：本页原来顶上有一行门店切换器（`persona__bar` + <StoreSwitcher />），
  //   随「切换门店」功能下线 —— 一个账号只有一家门店，人设也只属于那一家，没有可切换的对象。
  //   容器与它的 `&__bar` / `&__barhint` 样式一并删除。

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
    <View className='persona__intro'>
        <Text className='persona__title'>先创建你的门店</Text>
    </View>
    <View className='persona__footer'>
      <View className='persona__save' onClick={() => Taro.navigateTo({ url: '/pages/store/edit' })}><Text>去建店</Text></View>
    </View>
  </View>

  return (
    <View className='persona'>
      <View className='persona__intro'>
        <Text className='persona__title'>让顾客记住你的店</Text>
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
