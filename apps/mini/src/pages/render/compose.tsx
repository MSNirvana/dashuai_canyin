import { useEffect, useRef, useState, useCallback } from 'react'
import { View, Text, Button, Slider, Video } from '@tarojs/components'
import Taro, { useDidShow, useDidHide } from '@tarojs/taro'
import { getCreation, type CreationDetail } from '../../services/creation'
import {
  submitRender, listRenders, getRender, getPlayUrl, getResultPlayUrl,
  type RenderTask, type RenderGrade, type ColorGrade,
} from '../../services/render'
import { useMerchantStore } from '../../store/merchant'
import './compose.scss'

const DEFAULT_COLOR: ColorGrade = { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 }
const GRADE_RATIO: Record<RenderGrade, number> = { BASIC: 1, AI: 1.5, PREMIUM: 3 }
const GRADE_OPTIONS = [
  { key: 'BASIC' as const, title: '基础生成', desc: '粗剪拼接 + 调色' },
  { key: 'AI' as const, title: 'AI 生成', desc: '能力验收中，暂不可用' },
  { key: 'PREMIUM' as const, title: '精品生成', desc: '剪辑师人工精剪' },
]
const ACTIVE_STATUS = ['QUEUED', 'RUNNING', 'MANUAL_PENDING', 'MANUAL_DOING']
const STATUS_LABEL: Record<string, string> = {
  QUEUED: '排队中', RUNNING: '合成中', MANUAL_PENDING: '等待接单', MANUAL_DOING: '人工剪辑中',
  SUCCESS: '已完成', FAILED: '失败', TIMEOUT: '超时', CANCELLED: '已取消', REFUND_PENDING: '退款确认中',
}

// 仅作默认配置参考，不替代服务端实际结算。
function estimatePoints(shots: CreationDetail['shots'], grade: RenderGrade, recolor = false) {
  const seconds = shots.reduce((sum, shot) => {
    if (!shot.assetId) return sum
    const end = shot.trimEndMs ?? shot.assetDurationMs
    return sum + (end && end > shot.trimStartMs ? (end - shot.trimStartMs) / 1000 : shot.durationSuggest || 0)
  }, 0)
  return Math.max(1, Math.ceil(seconds * GRADE_RATIO[grade] * (recolor ? 0.5 : 1)))
}

export default function RenderCompose() {
  const id = Taro.getCurrentInstance().router?.params.id
  const { available, isMember, refreshMe } = useMerchantStore()
  const [detail, setDetail] = useState<CreationDetail | null>(null)
  const [color, setColor] = useState<ColorGrade>(DEFAULT_COLOR)
  const [grade, setGrade] = useState<RenderGrade>('BASIC')
  const [renders, setRenders] = useState<RenderTask[]>([])
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [selectedResult, setSelectedResult] = useState<RenderTask | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [visible, setVisible] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [resultError, setResultError] = useState('')
  const [pollError, setPollError] = useState('')
  const [pollRetry, setPollRetry] = useState(0)
  const submitLock = useRef(false)
  const previewVersion = useRef(0)
  const loadVersion = useRef(0)
  const pendingTask = renders.find((task) => ACTIVE_STATUS.includes(task.status)) ?? null
  const lastSuccess = renders.find((task) => task.status === 'SUCCESS') ?? null
  const missingShots = detail?.shots.filter((shot) => !shot.assetId) ?? []
  const materialsReady = !!detail?.shots.length && missingShots.length === 0

  const showResult = useCallback(async (task: RenderTask) => {
    const version = ++previewVersion.current
    setSelectedResult(task)
    setVideoUrl(null)
    setResultError('')
    try {
      if (!task.resultKey) throw new Error('成片地址暂不可用，请刷新重试')
      const result = await getResultPlayUrl(task.resultKey)
      if (version !== previewVersion.current) return
      if (!result.url) throw new Error('成片暂不可播放，请稍后重试')
      setVideoUrl(result.url)
    } catch (error) {
      if (version === previewVersion.current) setResultError((error as Error).message || '获取成片失败，请重试')
    }
  }, [])

  const load = useCallback(async () => {
    if (!id) { setLoadError('缺少创作编号'); return }
    const version = ++loadVersion.current
    setLoadError('')
    try {
      const [creation, tasks] = await Promise.all([getCreation(id), listRenders(id)])
      if (version !== loadVersion.current) return
      setDetail(creation)
      const sorted = [...tasks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      setRenders(sorted)
      const success = sorted.find((task) => task.status === 'SUCCESS')
      if (success) void showResult(success)
    } catch (error) {
      if (version === loadVersion.current) setLoadError((error as Error).message || '加载失败，请重试')
    }
  }, [id, showResult])

  useDidShow(() => {
    setVisible(true)
    void load()
    void refreshMe().catch(() => setLoadError('账户刷新失败，请重试'))
  })
  useDidHide(() => {
    setVisible(false)
    loadVersion.current += 1
    previewVersion.current += 1
  })
  useEffect(() => () => { loadVersion.current += 1; previewVersion.current += 1 }, [])

  useEffect(() => {
    if (!visible || !id || !pendingTask) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    setPollError('')
    const poll = async () => {
      try {
        const latest = await getRender(id, pendingTask.id)
        if (cancelled) return
        failures = 0
        setPollError('')
        setRenders((tasks) => tasks.map((task) => task.id === latest.id ? latest : task))
        if (!ACTIVE_STATUS.includes(latest.status)) {
          if (latest.status === 'SUCCESS') void showResult(latest)
          else setPollError(latest.errorMsg || '任务已结束，请查看任务状态与积分账户')
          void refreshMe().catch(() => setPollError('任务已结束，账户刷新失败，请重试'))
          return
        }
      } catch {
        if (cancelled) return
        failures += 1
        setPollError('进度查询失败，任务仍在后台处理，请勿重复提交')
        if (failures >= 3) return
      }
      if (!cancelled) timer = setTimeout(poll, 3000)
    }
    void poll()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [visible, id, pendingTask?.id, pollRetry, refreshMe, showResult])

  const previewShot = async (assetId: string) => {
    const version = ++previewVersion.current
    setSelectedResult(null)
    setVideoUrl(null)
    setResultError('')
    try {
      const result = await getPlayUrl(assetId)
      if (version !== previewVersion.current) return
      if (!result.url) throw new Error('素材暂不可播放')
      setVideoUrl(result.url)
    } catch (error) {
      if (version === previewVersion.current) setResultError((error as Error).message || '素材播放失败，请重试')
    }
  }

  const resultUrl = async () => {
    if (!selectedResult?.resultKey) throw new Error('请先选择已完成成片')
    const result = await getResultPlayUrl(selectedResult.resultKey)
    if (!result.url) throw new Error('下载地址暂不可用，请重试')
    return result.url
  }
  const copyDownload = async () => {
    try { await Taro.setClipboardData({ data: await resultUrl() }) }
    catch (error) { setResultError((error as Error).message || '复制下载链接失败') }
  }
  const saveResult = async () => {
    if (saving) return
    setSaving(true)
    try {
      const file = await Taro.downloadFile({ url: await resultUrl() })
      if (file.statusCode !== 200) throw new Error('下载失败，请重试或复制下载链接')
      await Taro.saveVideoToPhotosAlbum({ filePath: file.tempFilePath })
      void Taro.showToast({ title: '已保存到相册', icon: 'success' })
    } catch {
      setResultError('保存失败，请检查相册权限或复制下载链接。重复下载不扣积分。')
    } finally { setSaving(false) }
  }

  const doRender = async (mode: 'FULL' | 'RECOLOR') => {
    if (!id || !detail || submitLock.current || pendingTask) return
    if (!materialsReady) { setLoadError('请先补齐全部分镜素材'); return }
    if (grade === 'AI') return
    submitLock.current = true
    setSubmitting(true)
    try {
      await refreshMe()
      const account = useMerchantStore.getState()
      if (!account.isMember || Number(account.available) <= 0) {
        const result = await Taro.showModal({
          title: !account.isMember ? '需要订阅' : '积分不足',
          content: '订阅后可使用生成能力，积分按实际时长和档位结算。', confirmText: '去订阅充值',
        })
        if (result.confirm) await Taro.navigateTo({ url: '/pages/recharge/index' })
        return
      }
      const cost = estimatePoints(detail.shots, grade, mode === 'RECOLOR')
      const confirmed = await Taro.showModal({
        title: '确认生成',
        content: `参考预估 ${cost} 积分，可用 ${account.available} 积分。按实际时长及后台费率结算，失败后的积分以账户记录为准。`,
        confirmText: '确认提交',
      })
      if (!confirmed.confirm) return
      const { task } = await submitRender(id, { mode, grade, color, requestId: Date.now().toString(36) + Math.random().toString(36).slice(2, 8) })
      setRenders((tasks) => [task, ...tasks.filter((item) => item.id !== task.id)])
      if (task.status === 'SUCCESS') void showResult(task)
      void refreshMe().catch(() => setLoadError('任务已提交，账户刷新失败，请刷新查看'))
    } catch (error) {
      setLoadError((error as Error).message || '提交失败，请刷新任务列表后重试')
      void load()
    } finally { submitLock.current = false; setSubmitting(false) }
  }

  if (!detail) return <View className='rcompose__tip'>{loadError || '加载中…'}{loadError && <Button onClick={() => void load()}>重新加载</Button>}</View>
  const cost = estimatePoints(detail.shots, grade)
  return (
    <View className='rcompose'>
      <View className='rcompose__head'>
        <Text className='rcompose__title'>{detail.title || '未命名创作'}</Text>
        <Text className='rcompose__store'>{detail.store?.name}</Text>
      </View>
      {loadError && <View className='rcompose__notice'>{loadError}<Button size='mini' onClick={() => { void load(); void refreshMe().catch(() => setLoadError('账户刷新失败')) }}>刷新</Button></View>}
      <View className='rcompose__preview'>
        {videoUrl ? <Video className='rcompose__video' src={videoUrl} controls autoplay={false} onError={() => setResultError('播放失败，请重试获取地址')} /> : <View className='rcompose__placeholder'>暂无播放内容</View>}
      </View>
      {resultError && <View className='rcompose__notice'>{resultError}</View>}
      {selectedResult && <View className='rcompose__actions'>
        <Button size='mini' onClick={() => void showResult(selectedResult)}>重新播放</Button>
        <Button size='mini' loading={saving} disabled={saving} onClick={saveResult}>保存到相册</Button>
        <Button size='mini' onClick={copyDownload}>复制下载链接</Button>
      </View>}
      {renders.length > 0 && <View className='rcompose__sec'>
        <Text className='rcompose__sectitle'>成片记录</Text>
        {renders.map((task) => <View className='rcompose__history' key={task.id}>
          <Text>{GRADE_OPTIONS.find((option) => option.key === task.grade)?.title || task.grade} · {STATUS_LABEL[task.status] || task.status}</Text>
          <Text>{task.finishAt || task.createdAt} · {task.status === 'SUCCESS' ? '结算' : '任务积分'} {task.beanCharged} 积分</Text>
          {task.errorMsg && <Text>{task.errorMsg}</Text>}
          {task.status === 'SUCCESS' && <Button size='mini' onClick={() => void showResult(task)}>播放成片</Button>}
        </View>)}
      </View>}
      <View className='rcompose__sec'>
        <Text className='rcompose__sectitle'>分镜素材 · 已上传 {detail.shots.length - missingShots.length}/{detail.shots.length}</Text>
        {!materialsReady && <View className='rcompose__notice'>
          {detail.shots.length ? `缺少分镜 ${missingShots.map((shot) => shot.seq).join('、')} 的素材` : '尚无分镜'}
          <Button size='mini' onClick={() => Taro.navigateTo({ url: `/pages/creation/shots?id=${id}` })}>去上传素材</Button>
        </View>}
        {detail.shots.map((shot) => <View className='rcompose__clip' key={shot.id}>
          <Text>分镜 {shot.seq} · {shot.assetId ? '已上传' : '缺素材'}</Text>
          {shot.assetId && <Button size='mini' onClick={() => void previewShot(shot.assetId!)}>预览</Button>}
        </View>)}
      </View>
      <View className='rcompose__sec'>
        <Text className='rcompose__sectitle'>生成方式</Text>
        <View className='rcompose__grades'>
          {GRADE_OPTIONS.map((option) => <View key={option.key} className={`rcompose__grade ${grade === option.key ? 'rcompose__grade--on' : ''} ${option.key === 'AI' ? 'rcompose__grade--disabled' : ''}`} onClick={() => { if (option.key !== 'AI') setGrade(option.key) }}>
            <Text className='rcompose__gradetitle'>{option.title}</Text><Text className='rcompose__gradedesc'>{option.desc}</Text>
          </View>)}
        </View>
        <View className='rcompose__notice'>{isMember ? '已订阅' : '未订阅，生成前需开通'} · 可用 {available} 积分。参考预估按默认每秒积分与档位系数计算，实际结算以后端为准。</View>
        {grade === 'PREMIUM' && <View className='rcompose__premiumtip'>提交后进入人工队列，可在本页查看进度与交付结果。</View>}
      </View>
      {grade !== 'PREMIUM' && <View className='rcompose__sec'>
        <Text className='rcompose__sectitle'>整片调色</Text>
        {([['brightness', '亮度'], ['contrast', '对比度'], ['saturation', '饱和度'], ['sharpen', '锐化']] as [keyof ColorGrade, string][]).map(([axis, label]) => <View className='rcompose__slider' key={axis}>
          <Text className='rcompose__slabel'>{label}</Text><Slider className='rcompose__sbar' min={-100} max={100} value={color[axis]} showValue activeColor='#e63946' onChange={(event: { detail: { value: number } }) => setColor((previous) => ({ ...previous, [axis]: event.detail.value }))} />
        </View>)}
      </View>}
      {pendingTask && <View className='rcompose__progress'>{STATUS_LABEL[pendingTask.status]} · {pendingTask.progress}%{pendingTask.deadlineAt && ` · 预计交付 ${pendingTask.deadlineAt}`}</View>}
      {pollError && <View className='rcompose__notice'>{pollError}<Button size='mini' onClick={() => { setPollRetry((value) => value + 1); void load() }}>重新查询</Button></View>}
      {lastSuccess && grade === 'BASIC' && <Button className='rcompose__recolor' loading={submitting} disabled={submitting || !!pendingTask || !materialsReady} onClick={() => void doRender('RECOLOR')}>仅调色重生成（参考 {estimatePoints(detail.shots, grade, true)} 积分）</Button>}
      <View className='rcompose__bar'>
        <View className='rcompose__cost'><Text className='rcompose__costnum'>约 {cost}</Text><Text className='rcompose__costunit'>积分</Text><Text className='rcompose__balance'>可用 {available}</Text></View>
        <Button className='rcompose__render' loading={submitting} disabled={submitting || !!pendingTask || !materialsReady} onClick={() => void doRender('FULL')}>{pendingTask ? '任务处理中' : lastSuccess ? '重新生成' : '生成成片'}</Button>
      </View>
    </View>
  )
}
