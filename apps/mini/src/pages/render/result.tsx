// 成片记录详情页：一条成片的全部可交付信息 —— 视频、封面、标题、文案。
//
// 为什么独立成页（而不是在「合成成片」页里展开）：
//   那个页面是要**干活**的（选档位、调色、生成、比对各档位），一屏里塞不下
//   「视频 + 竖版封面 + 标题 + 一长段文案」。而这条记录本身就是**交付物** ——
//   用户来这里只做三件事：看一眼、把视频存到相册、把标题文案复制去发布。
//   两件事的界面目标不同，硬合在一起就是两边都别扭。
//
// ★ 两个数据来源，各自独立失败：
//   · 视频（render task + resultKey 签名地址）—— 这条记录的成片
//   · 发布素材（title / caption / cover）—— 挂在**创作**上（每个创作一份），
//     可能压根还没生成（material = null），也可能生成失败（coverError 非空）。
//   所以下面刻意分成两块渲染：素材没生成不该让视频也看不见。
import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, Button, Video, Image } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import { getRender, listRenders, getResultPlayUrl, type RenderTask } from '../../services/render'
import { getPublishMaterial, type PublishMaterial, type PublishMaterialEstimate } from '../../services/publish-material'
import { isNumericId } from '../../utils/route-id'
// 时间一律走这里：接口给的是 UTC 的 ISO 串（…T…Z），直接渲染会露出 T、Z 且差 8 小时
import { formatMinute } from '../../utils/time'
import './result.scss'

const GRADE_LABEL: Record<string, string> = {
  BASIC: '基础生成',
  AI: 'AI 增强',
  PREMIUM: '精品档',
}

const STATUS_LABEL: Record<string, string> = {
  QUEUED: '排队中',
  RUNNING: '生成中',
  SUCCESS: '已完成',
  FAILED: '失败',
  TIMEOUT: '超时',
}

export default function RenderResult() {
  const router = useRouter()
  const creationId = isNumericId(router.params?.id) ? (router.params!.id as string) : null
  const taskId = isNumericId(router.params?.task) ? (router.params!.task as string) : null

  const [task, setTask] = useState<RenderTask | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [material, setMaterial] = useState<PublishMaterial | null>(null)
  const [estimate, setEstimate] = useState<PublishMaterialEstimate | null>(null)
  const [loadError, setLoadError] = useState('')
  const [mediaError, setMediaError] = useState('')
  const [saving, setSaving] = useState(false)
  /** 代次：页面重进 / 重新加载时，先回来的旧响应不许覆盖后发起的结果 */
  const versionRef = useRef(0)

  const load = useCallback(async () => {
    if (!creationId) {
      setLoadError('页面编号丢失，请回「合成成片」重新进入')
      return
    }
    const version = ++versionRef.current
    setLoadError('')
    setMediaError('')
    try {
      // 任务与素材并行拉：两者互不依赖，串行只会让首屏多等一个 RTT
      const [loadedTask, materialRes] = await Promise.all([
        // 没带 taskId 时退到「最新一条成功的成片」——从别处（如创作列表）跳进来时不会有 taskId
        taskId
          ? getRender(creationId, taskId)
          : listRenders(creationId).then((list) => {
              const success = [...list]
                .filter((t) => t.status === 'SUCCESS' && t.resultKey)
                .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
              if (!success) throw new Error('这条创作还没有可播放的成片')
              return success
            }),
        // 素材读取失败**不**让整页失败：视频才是这个页面的主体（见文件头）
        getPublishMaterial(creationId).catch(() => null),
      ])
      if (version !== versionRef.current) return
      setTask(loadedTask)
      if (materialRes) {
        setMaterial(materialRes.material)
        setEstimate(materialRes.estimate)
      }
      if (loadedTask.resultKey) {
        // ★ 结果地址每次进页面现签：签名 URL 会过期，缓存进 storage 隔天就是打不开的黑屏
        const play = await getResultPlayUrl(loadedTask.resultKey)
        if (version !== versionRef.current) return
        if (play.url) setVideoUrl(play.url)
        else setMediaError('视频地址暂不可用，请稍后重试')
      }
    } catch (error) {
      if (version !== versionRef.current) return
      setLoadError((error as Error).message || '加载失败，请稍后重试')
    }
  }, [creationId, taskId])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * 保存视频到相册。
   *
   * ★ 必须走 `downloadFile` 再 `saveVideoToPhotosAlbum`：后者只吃**本地临时文件**，
   *   直接喂 https 地址会失败，而报错是原生的一句英文，对用户毫无指导意义。
   * ★ 失败原因绝大多数是「相册权限被拒」，且**只有第一次**会弹授权框；
   *   之后每次都直接失败。所以这里给一句能照着做的指引（去设置里打开），
   *   而不是把原生错误原文抛给用户。
   */
  const saveVideo = async () => {
    if (saving) return
    if (!videoUrl) {
      setMediaError('视频地址还没取到，请稍后重试')
      return
    }
    setSaving(true)
    setMediaError('')
    try {
      const file = await Taro.downloadFile({ url: videoUrl })
      if (file.statusCode !== 200) {
        setMediaError('下载失败，请重试或改用「复制下载链接」')
        return
      }
      await Taro.saveVideoToPhotosAlbum({ filePath: file.tempFilePath })
      void Taro.showToast({ title: '已保存到相册', icon: 'success' })
    } catch {
      setMediaError('保存失败：请在小程序设置里允许「保存到相册」，或改用「复制下载链接」自行下载。')
    } finally {
      setSaving(false)
    }
  }

  const copyVideoUrl = async () => {
    if (!videoUrl) {
      setMediaError('视频地址还没取到，请稍后重试')
      return
    }
    try {
      await Taro.setClipboardData({ data: videoUrl })
    } catch {
      setMediaError('复制失败，请稍后重试')
    }
  }

  const copyText = async (text: string, label: string) => {
    if (!text) return
    try {
      await Taro.setClipboardData({ data: text })
      void Taro.showToast({ title: `${label}已复制`, icon: 'success' })
    } catch {
      void Taro.showToast({ title: '复制失败', icon: 'none' })
    }
  }

  if (loadError) {
    return (
      <View className='rresult__tip'>
        {loadError}
        <Button className='ds-btn' onClick={() => void load()}>重新加载</Button>
        <Button className='ds-btn' onClick={() => Taro.navigateBack()}>返回</Button>
      </View>
    )
  }

  if (!task) return <View className='rresult__tip'>加载中…</View>

  const isReady = task.status === 'SUCCESS' && !!task.resultKey

  return (
    <View className='rresult'>
      {/* ── 视频 ── */}
      <View className='rresult__card rresult__card--hero'>
        <View className='rresult__head'>
          <Text className='rresult__title'>{GRADE_LABEL[task.grade] || task.grade}</Text>
          <Text
            className={`ds-pill ${
              isReady ? 'ds-pill--green' : task.status === 'FAILED' || task.status === 'TIMEOUT' ? 'ds-pill--red-soft' : 'ds-pill--gold'
            }`}
          >
            {STATUS_LABEL[task.status] || task.status}
          </Text>
        </View>
        <Text className='rresult__meta'>
          {formatMinute(task.finishAt || task.createdAt)} · 消耗 {task.beanCharged} 积分
          {task.durationMs ? ` · 时长约 ${Math.round(task.durationMs / 1000)}s` : ''}
        </Text>
        {/* ★ 失败/未完成时**不**渲染播放器：一个没地址的空白播放器只会让人以为坏掉了，
            这里直接说清楚状态，并保留 errorText（服务端已脱敏，见 services/render.ts） */}
        {isReady ? (
          videoUrl ? (
            <Video className='rresult__video' src={videoUrl} controls autoplay={false} objectFit='contain' />
          ) : (
            <View className='rresult__videoph'>{mediaError || '正在取视频地址…'}</View>
          )
        ) : (
          <View className='rresult__videoph'>
            {task.errorText || '这条成片还没有产出视频'}
          </View>
        )}
        {isReady && (
          <View className='rresult__acts'>
            <Button className='ds-btn ds-btn--primary rresult__act' loading={saving} onClick={() => void saveVideo()}>
              保存到相册
            </Button>
            <Button className='ds-btn rresult__act' onClick={() => void copyVideoUrl()}>复制下载链接</Button>
          </View>
        )}
        {/* mediaError 在按钮上方也可能已被消费（播放器占位），这里只在播放器正常时才重复提示 */}
        {isReady && videoUrl && !!mediaError && <Text className='rresult__err'>{mediaError}</Text>}
      </View>

      {/* ── 发布素材（标题 / 封面 / 文案）── */}
      <View className='rresult__card rresult__card--publish'>
        <View className='rresult__head'>
          <Text className='rresult__title'>发布素材</Text>
          {material && (
            <Button
              className='rresult__mini'
              size='mini'
              onClick={() => Taro.navigateTo({ url: `/pages/render/compose?id=${creationId}` })}
            >
              去重新生成
            </Button>
          )}
        </View>

        {!material ? (
          <View className='rresult__empty'>
            <Text className='rresult__emptytitle'>还没有生成发布素材</Text>
            <Text className='rresult__emptytext'>
              在「合成成片」页点「生成发布素材」，会按口播文案给出标题、封面与文案
              {estimate ? `（标题/文案最多 ${estimate.textBeanCap} 积分，封面固定 ${estimate.coverBeans} 积分）` : ''}。
            </Text>
            <Button
              className='ds-btn ds-btn--primary'
              onClick={() => Taro.navigateTo({ url: `/pages/render/compose?id=${creationId}` })}
            >
              去生成
            </Button>
          </View>
        ) : (
          <>
            {material.coverUrl ? (
              <Image className='rresult__cover' mode='aspectFill' src={material.coverUrl} />
            ) : (
              <View className='rresult__coverph'>
                <Text className='rresult__coverphtext'>
                  {material.coverError || '封面还没生成出来'}
                </Text>
              </View>
            )}
            {!!material.coverUrl && (
              <Text className='rresult__hint'>
                封面 {material.coverWidth}×{material.coverHeight}（3:4 竖版）
              </Text>
            )}

            <View className='rresult__block'>
              <View className='rresult__blockhead'>
                <Text className='rresult__blocktitle'>标题</Text>
                <Text className='rresult__copy' onClick={() => void copyText(material.title, '标题')}>复制</Text>
              </View>
              <Text className='rresult__value'>{material.title || '（空）'}</Text>
            </View>

            <View className='rresult__block'>
              <View className='rresult__blockhead'>
                <Text className='rresult__blocktitle'>文案</Text>
                <Text className='rresult__copy' onClick={() => void copyText(material.caption, '文案')}>复制</Text>
              </View>
              <Text className='rresult__value rresult__value--caption'>{material.caption || '（空）'}</Text>
            </View>

            {/* 兜底标记：不提示的话，用户会以为「模型就这水平」而不是「这次 AI 没成功」 */}
            {material.degraded && (
              <Text className='rresult__warn'>这次的标题与文案是简单拼出来的（AI 没给出可用结果），可以重新生成一次。</Text>
            )}
            {!!material.coverError && (
              <Text className='rresult__warn'>{material.coverError}</Text>
            )}
          </>
        )}
      </View>
    </View>
  )
}
