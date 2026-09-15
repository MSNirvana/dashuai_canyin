import { useEffect, useRef, useState, useCallback } from 'react'
import { View, Text, Button, Slider, Video, Image, Switch, Textarea } from '@tarojs/components'
import Taro, { useDidShow, useDidHide } from '@tarojs/taro'
import { getCreation, type CreationDetail } from '../../services/creation'
import {
  submitRender, listRenders, getRender, getPlayUrl, getResultPlayUrl, getGradeCapabilities,
  type RenderTask, type RenderGrade, type ColorGrade, type ChatCutOptions, CHATCUT_VOICES,
} from '../../services/render'
import { useMerchantStore } from '../../store/merchant'
import ProgressLine from '../../components/progress-line'
import './compose.scss'

const DEFAULT_COLOR: ColorGrade = { brightness: 0, contrast: 0, saturation: 0, sharpen: 0 }
const GRADE_RATIO: Record<RenderGrade, number> = { BASIC: 1, AI: 1.5, PREMIUM: 3 }
const DEFAULT_CHATCUT: ChatCutOptions = {
  voiceId: 'warm-female', subtitles: true, subtitleStyle: 'CLEAN', bgm: 'LIGHT',
  pacing: 'NATURAL', transitions: 'CLEAN', removeSilence: true, normalizeAudio: true, note: '',
}
const GRADE_OPTIONS = [
  { key: 'BASIC' as const, title: '基础生成', desc: '粗剪拼接 + 调色' },
  { key: 'AI' as const, title: 'AI 生成', desc: 'AI 配音 + 字幕' },
  { key: 'PREMIUM' as const, title: '精品生成', desc: '剪辑师人工精剪' },
]
const ACTIVE_STATUS = ['QUEUED', 'RUNNING', 'MANUAL_PENDING', 'MANUAL_DOING']
const STATUS_LABEL: Record<string, string> = {
  QUEUED: '排队中', RUNNING: '合成中', MANUAL_PENDING: '等待接单', MANUAL_DOING: '人工剪辑中',
  SUCCESS: '已完成', FAILED: '失败', TIMEOUT: '超时', CANCELLED: '已取消',
  REFUND_PENDING: '退款确认中', SETTLEMENT_PENDING: '退款确认中',
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
  const [chatcut, setChatcut] = useState<ChatCutOptions>(DEFAULT_CHATCUT)
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
  const [refreshingHistory, setRefreshingHistory] = useState(false)
  // P0-5：不可用档位 → 原因文案。空对象表示「都可用」（含能力接口拉取失败时的保守放行）
  const [gradeIssues, setGradeIssues] = useState<Partial<Record<RenderGrade, string>>>({})
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

  /**
   * P0-5 档位能力：服务端环境决定 AI 档能不能用（依赖外部剪辑通道配置）。
   * 拉取失败时**保守放行**（不标灰），因为服务端在 freeze 之前还会再硬拒一次（4013），
   * 客户端标灰只是体验优化，不能因为一次网络抖动把档位全锁死。
   */
  const loadCapabilities = useCallback(async () => {
    try {
      const r = await getGradeCapabilities()
      const issues: Partial<Record<RenderGrade, string>> = {}
      for (const g of r.grades) if (!g.available) issues[g.key] = g.reason || '该档位暂不可用'
      setGradeIssues(issues)
      // 当前选中的档位如果已不可用，回退到 BASIC，避免用户点了提交才发现
      setGrade((cur) => (issues[cur] ? 'BASIC' : cur))
    } catch {
      setGradeIssues({})
    }
  }, [])

  useDidShow(() => {
    setVisible(true)
    void load()
    void loadCapabilities()
    void refreshMe().catch(() => setLoadError('账户刷新失败，请重试'))
  })
  useDidHide(() => {
    setVisible(false)
    loadVersion.current += 1
    previewVersion.current += 1
  })
  useEffect(() => () => { loadVersion.current += 1; previewVersion.current += 1 }, [])

  useEffect(() => {
    Taro.setNavigationBarTitle({ title: '合成成片' })
  }, [])

  useEffect(() => {
    if (!visible || !id || !pendingTask) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    // 轮询必须封顶：服务端 sweeper 正常时任务 30 分钟内一定收敛，但如果 sweeper 挂了 /
    // 任务卡在 sweeper 不认的状态里，客户端原实现会每 3 秒请求一次、永不停止 ——
    // 用户把页面留在后台就是一整晚的网络与电量消耗。超过上限就停下来并明确告知。
    const startedAt = Date.now()
    const POLL_MAX_MS = 30 * 60 * 1000
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
        if (Date.now() - startedAt >= POLL_MAX_MS) {
          setPollError('已等待超过 30 分钟，任务仍在后台处理。可先离开此页，稍后在「我的作品」查看结果；若有异常请联系客服。')
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

  const reloadHistory = async () => {
    if (!id || refreshingHistory) return
    setRefreshingHistory(true)
    try {
      const tasks = await listRenders(id)
      setRenders([...tasks].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)))
      setPollError('')
    } catch (error) {
      setPollError((error as Error).message || '任务记录刷新失败，请重试')
    } finally {
      setRefreshingHistory(false)
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
    // P0-5 纵深防御：UI 已把不可用档位标灰，但状态可能过期（例如页面停留期间服务端改了配置），
    // 这里再拦一道，并顺手刷新一次能力表，避免用户反复点到同一个拒绝。
    if (gradeIssues[grade]) {
      setLoadError(gradeIssues[grade] as string)
      void loadCapabilities()
      return
    }
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
      const { task } = await submitRender(id, {
        mode, grade, color,
        chatcut: grade === 'AI' ? chatcut : undefined,
        requestId: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      })
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
  const previewedGrade = selectedResult
    ? GRADE_OPTIONS.find((option) => option.key === selectedResult.grade)?.title || selectedResult.grade
    : ''
  return (
    <View className='rcompose'>
      <View className='rcompose__stage'>
        <Text className='rcompose__stage-kicker'>STEP 4 OF 4 · FINISH</Text>
        <Text className='rcompose__stage-title'>把素材剪成一条能发布的视频</Text>
        <Text className='rcompose__stage-desc'>选择生成方式，确认预计消耗后提交。失败会全额返还积分。</Text>
      </View>
      <View className='rcompose__head'>
        <View className='rcompose__headmain'>
          <Text className='rcompose__title'>{detail.title || '未命名创作'}</Text>
          <Text className='rcompose__store'>{detail.store?.name}</Text>
        </View>
        <Text className={`rcompose__materials ${missingShots.length === 0 ? 'rcompose__materials--ok' : ''}`}>
          素材 {detail.shots.length - missingShots.length}/{detail.shots.length} {missingShots.length === 0 ? '✓' : ''}
        </Text>
      </View>

      {/* ── 预览 ── */}
      <View className='rcompose__preview'>
        {videoUrl ? (
          <Video className='rcompose__video' src={videoUrl} controls autoplay={false} onError={() => setResultError('播放失败，请重试获取地址')} />
        ) : (
          <View className='rcompose__placeholder'>
            {selectedResult ? '成片地址暂不可用，请稍后重试' : '点击下方分镜素材可预览视频'}
          </View>
        )}
        {!!previewedGrade && <Text className='rcompose__preview-badge'>{previewedGrade}</Text>}
      </View>

      {resultError && <View className='ds-notice rcompose__notice'>{resultError}</View>}

      {selectedResult && (
        <View className='rcompose__actions'>
          <Button className='rcompose__action' size='mini' onClick={() => void showResult(selectedResult)}>重新播放</Button>
          <Button className='rcompose__action' size='mini' loading={saving} disabled={saving} onClick={saveResult}>保存到相册</Button>
          <Button className='rcompose__action' size='mini' onClick={copyDownload}>复制链接</Button>
        </View>
      )}

      {loadError && (
        <View className='ds-notice rcompose__notice'>
          <Text>{loadError}</Text>
          <Button size='mini' onClick={() => { void load(); void refreshMe().catch(() => setLoadError('账户刷新失败')) }}>刷新</Button>
        </View>
      )}

      {/* ── 生成方式 ── */}
      <View className='rcompose__card'>
        <Text className='rcompose__sectitle'>生成方式</Text>
        <View className='rcompose__grades'>
          {GRADE_OPTIONS.map((option) => {
            const issue = gradeIssues[option.key]
            const off = !!issue
            return (
              <View
                key={option.key}
                className={`rcompose__grade ${grade === option.key ? 'rcompose__grade--on' : ''} ${off ? 'rcompose__grade--off' : ''}`}
                onClick={() => {
                  if (off) {
                    Taro.showToast({ title: issue, icon: 'none', duration: 2500 })
                    return
                  }
                  setGrade(option.key)
                }}
              >
                <Text className='rcompose__gradetitle'>{option.title}</Text>
                <Text className='rcompose__gradedesc'>{option.desc}</Text>
                {off ? (
                  <Text className='rcompose__graderatio'>即将开放</Text>
                ) : (
                  <Text className='rcompose__graderatio'>{GRADE_RATIO[option.key].toFixed(1)}×</Text>
                )}
              </View>
            )
          })}
        </View>
        {!!gradeIssues[grade] && (
          <View className='ds-notice ds-notice--warn rcompose__premiumtip'>{gradeIssues[grade]}</View>
        )}
        {grade === 'PREMIUM' && (
          <View className='ds-notice ds-notice--warn rcompose__premiumtip'>提交后进入人工队列，可在本页查看进度与交付结果。</View>
        )}
      </View>

      {grade === 'AI' && (
        <View className='rcompose__card'>
          <Text className='rcompose__sectitle'>AI 成片选项</Text>
          <Text className='rcompose__fieldlabel'>选择配音</Text>
          <View className='rcompose__voicegrid'>
            {CHATCUT_VOICES.map((voice) => (
              <View key={voice.id} className={`rcompose__voice ${chatcut.voiceId === voice.id ? 'rcompose__voice--on' : ''}`} onClick={() => setChatcut((value) => ({ ...value, voiceId: voice.id }))}>
                <Text className='rcompose__voicename'>{voice.name}</Text>
                <Text className='rcompose__voicedesc'>{voice.desc}</Text>
              </View>
            ))}
          </View>
          <View className='rcompose__optionrow'>
            <View><Text className='rcompose__optiontitle'>显示字幕</Text><Text className='rcompose__optiondesc'>将分镜口播同步到画面</Text></View>
            <Switch checked={chatcut.subtitles} onChange={(event) => setChatcut((value) => ({ ...value, subtitles: event.detail.value }))} color='#e1251b' />
          </View>
          {chatcut.subtitles && <View className='rcompose__choice'><Text className='rcompose__fieldlabel'>字幕样式</Text><View className='rcompose__choices'>{(['CLEAN', 'EMPHASIS', 'SOCIAL'] as const).map((value) => <Text key={value} className={`rcompose__choiceitem ${chatcut.subtitleStyle === value ? 'rcompose__choiceitem--on' : ''}`} onClick={() => setChatcut((item) => ({ ...item, subtitleStyle: value }))}>{value === 'CLEAN' ? '简洁' : value === 'EMPHASIS' ? '重点强调' : '社交风格'}</Text>)}</View></View>}
          <View className='rcompose__choice'><Text className='rcompose__fieldlabel'>配乐</Text><View className='rcompose__choices'>{(['NONE', 'LIGHT', 'UPBEAT', 'PREMIUM'] as const).map((value) => <Text key={value} className={`rcompose__choiceitem ${chatcut.bgm === value ? 'rcompose__choiceitem--on' : ''}`} onClick={() => setChatcut((item) => ({ ...item, bgm: value }))}>{value === 'NONE' ? '无配乐' : value === 'LIGHT' ? '轻柔' : value === 'UPBEAT' ? '活力' : '高级感'}</Text>)}</View></View>
          <View className='rcompose__choice'><Text className='rcompose__fieldlabel'>剪辑节奏</Text><View className='rcompose__choices'>{(['NATURAL', 'FAST', 'STORY'] as const).map((value) => <Text key={value} className={`rcompose__choiceitem ${chatcut.pacing === value ? 'rcompose__choiceitem--on' : ''}`} onClick={() => setChatcut((item) => ({ ...item, pacing: value }))}>{value === 'NATURAL' ? '自然' : value === 'FAST' ? '明快' : '叙事'}</Text>)}</View></View>
          <View className='rcompose__choice'><Text className='rcompose__fieldlabel'>转场风格</Text><View className='rcompose__choices'>{(['CLEAN', 'SMOOTH', 'DYNAMIC'] as const).map((value) => <Text key={value} className={`rcompose__choiceitem ${chatcut.transitions === value ? 'rcompose__choiceitem--on' : ''}`} onClick={() => setChatcut((item) => ({ ...item, transitions: value }))}>{value === 'CLEAN' ? '干净利落' : value === 'SMOOTH' ? '平滑自然' : '动感切换'}</Text>)}</View></View>
          <View className='rcompose__optionrow'><View><Text className='rcompose__optiontitle'>清理停顿</Text><Text className='rcompose__optiondesc'>交给 ChatCut 处理语音空白</Text></View><Switch checked={chatcut.removeSilence} onChange={(event) => setChatcut((value) => ({ ...value, removeSilence: event.detail.value }))} color='#e1251b' /></View>
          <View className='rcompose__optionrow'><View><Text className='rcompose__optiontitle'>统一音量</Text><Text className='rcompose__optiondesc'>平衡配音、原声与配乐响度</Text></View><Switch checked={chatcut.normalizeAudio} onChange={(event) => setChatcut((value) => ({ ...value, normalizeAudio: event.detail.value }))} color='#e1251b' /></View>
          <Text className='rcompose__fieldlabel'>备注与关键字</Text>
          <Textarea className='rcompose__note' maxlength={300} placeholder='例如：突出招牌菜、适合小红书种草' value={chatcut.note} onInput={(event) => setChatcut((value) => ({ ...value, note: event.detail.value }))} />
        </View>
      )}

      {/* ── 整片调色 ── */}
      {grade !== 'PREMIUM' && (
        <View className='rcompose__card'>
          <Text className='rcompose__sectitle'>整片调色</Text>
          {([['brightness', '亮度'], ['contrast', '对比度'], ['saturation', '饱和度'], ['sharpen', '锐化']] as [keyof ColorGrade, string][]).map(([axis, label]) => (
            <View className='rcompose__slider' key={axis}>
              <Text className='rcompose__slabel'>{label}</Text>
              <Slider
                className='rcompose__sbar'
                min={-100}
                max={100}
                value={color[axis]}
                showValue
                activeColor='#e1251b'
                blockSize={22}
                onChange={(event: { detail: { value: number } }) => setColor((previous) => ({ ...previous, [axis]: event.detail.value }))}
              />
            </View>
          ))}
        </View>
      )}

      {/* ── 进行中的任务 ── */}
      {pendingTask && (
        <View className='rcompose__card'>
          <ProgressLine
            percent={pendingTask.progress}
            label={STATUS_LABEL[pendingTask.status] || pendingTask.status}
            hint={pendingTask.deadlineAt ? `预计交付 ${pendingTask.deadlineAt}` : '处理中，请保持页面打开'}
          />
        </View>
      )}
      {pollError && (
        <View className='ds-notice rcompose__notice'>
          <Text>{pollError}</Text>
          <Button size='mini' onClick={() => { setPollRetry((value) => value + 1); void load() }}>重新查询</Button>
        </View>
      )}

      {/* ── 成片记录 ── */}
      {renders.length > 0 && (
        <View className='rcompose__card'>
          <View className='rcompose__history-heading'>
            <Text className='rcompose__sectitle'>成片记录</Text>
            <Button size='mini' loading={refreshingHistory} disabled={refreshingHistory} onClick={() => void reloadHistory()}>刷新</Button>
          </View>
          {renders.map((task) => (
            <View className='rcompose__history' key={task.id}>
              <View className='rcompose__history-top'>
                <Text className='rcompose__history-title'>
                  {GRADE_OPTIONS.find((option) => option.key === task.grade)?.title || task.grade}
                </Text>
                <Text
                  className={`ds-pill ${
                    task.status === 'SUCCESS'
                      ? 'ds-pill--green'
                      : task.status === 'FAILED' || task.status === 'TIMEOUT'
                        ? 'ds-pill--red-soft'
                        : 'ds-pill--gold'
                  }`}
                >
                  {STATUS_LABEL[task.status] || task.status}
                </Text>
              </View>
              <Text className='rcompose__history-meta'>
                {task.finishAt || task.createdAt} · {task.status === 'SUCCESS' ? '结算' : '任务积分'} {task.beanCharged} 积分
              </Text>
              {task.errorMsg && <Text className='rcompose__history-err'>{task.errorMsg}</Text>}
              {task.status === 'SUCCESS' && (
                <Button className='rcompose__action' size='mini' onClick={() => void showResult(task)}>播放成片</Button>
              )}
            </View>
          ))}
        </View>
      )}

      {/* ── 分镜素材 ── */}
      <View className='rcompose__card'>
        <Text className='rcompose__sectitle'>分镜素材 · 已上传 {detail.shots.length - missingShots.length}/{detail.shots.length}</Text>
        {!materialsReady && (
          <View className='ds-notice rcompose__notice'>
            <Text>{detail.shots.length ? `缺少分镜 ${missingShots.map((shot) => shot.seq).join('、')} 的素材` : '尚无分镜'}</Text>
            <Button size='mini' onClick={() => Taro.navigateTo({ url: `/pages/creation/shots?id=${id}` })}>去上传素材</Button>
          </View>
        )}
        {detail.shots.map((shot) => (
          <View className='rcompose__clip' key={shot.id}>
            {/* 缩略图：有素材则展示，无则占位 */}
            <View className='rcompose__clipthumbwrap' onClick={() => shot.assetId && previewShot(shot.assetId!)}>
              {shot.assetId && shot.coverUrl ? (
                <Image className='rcompose__clipthumb' mode='aspectFill' src={shot.coverUrl} />
              ) : (
                <View className='rcompose__clipthumbph'>
                  <Text className='rcompose__clipthumbno'>{String(shot.seq).padStart(2, '0')}</Text>
                  <Text className='rcompose__clipthumbtip'>{shot.assetId ? '缩略图生成中' : '缺素材'}</Text>
                </View>
              )}
              {shot.assetId && <View className='rcompose__clipplay' />}
            </View>
            {/* 分镜信息 */}
            <View className='rcompose__clipinfo'>
              <View className='rcompose__cliphead'>
                <Text className='rcompose__clipseq'>{shot.seq}</Text>
                <Text className='rcompose__cliptype'>{shot.shotType || '通用'}</Text>
                {!!shot.shotSize && <Text className='rcompose__clipmeta'>{shot.shotSize}</Text>}
                {!!shot.durationSuggest && <Text className='rcompose__clipmeta'>建议 {shot.durationSuggest}s</Text>}
              </View>
              {!!shot.line && <Text className='rcompose__clipline'>{shot.line}</Text>}
              {shot.assetId ? (
                <Button className='rcompose__action' size='mini' onClick={() => void previewShot(shot.assetId!)}>预览</Button>
              ) : (
                <Text className='rcompose__clipstate'>未上传</Text>
              )}
            </View>
          </View>
        ))}
      </View>

      {lastSuccess && grade === 'BASIC' && (
        <Button
          className='rcompose__recolor'
          loading={submitting}
          disabled={submitting || !!pendingTask || !materialsReady}
          onClick={() => void doRender('RECOLOR')}
        >
          仅调色重生成（参考 {estimatePoints(detail.shots, grade, true)} 积分）
        </Button>
      )}

      {/* ── 底部：积分预估 + 生成 ── */}
      <View className='ds-footer'>
        <View className='rcompose__bar'>
          <View className='rcompose__cost'>
            <View className='rcompose__costnum'>
              <Text className='rcompose__cost-label'>约</Text>
              <Text className='rcompose__cost-value ds-num'>{cost}</Text>
              <Text className='rcompose__cost-unit'>积分</Text>
            </View>
            <Text className='rcompose__balance'>
              可用 {available} · {isMember ? '已订阅' : '未订阅，生成前需开通'}
            </Text>
          </View>
          <Button
            className='ds-btn ds-btn--primary rcompose__render'
            hoverClass='ds-hover'
            loading={submitting}
            disabled={submitting || !!pendingTask || !materialsReady}
            onClick={() => void doRender('FULL')}
          >
            {pendingTask ? '任务处理中' : lastSuccess ? '重新生成' : '生成成片'}
          </Button>
        </View>
        <View className='ds-footer__note'>参考预估按每秒积分与档位系数计算，按实际时长结算，失败全额返还</View>
      </View>
    </View>
  )
}
