import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { View, Text, Button, Image } from '@tarojs/components'
import Taro from '@tarojs/taro'
import {
  getCreation,
  updateShotAsset,
  ensureShotCovers,
  getAssetPlayUrl,
  type CreationDetail,
  type ShotItem,
} from '../../services/creation'
import { listShotLibrary, getShotDemoPlayUrl, type ShotLibraryItem } from '../../services/account'
import { uploadVideoFile, UploadAbortedError } from '../../services/upload'
import ProgressLine from '../../components/progress-line'
import './shots.scss'

/** 时长格式化：83.4s → 1:23 */
function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function CreationShots() {
  const params = Taro.getCurrentInstance().router?.params ?? {}
  const id = params.id
  const [detail, setDetail] = useState<CreationDetail | null>(null)
  const [progress, setProgress] = useState<Record<string, number>>({})
  /** 各分镜独立上传状态：允许多个素材并发上传，不再用单个 shotId 锁住整页 */
  const [uploading, setUploading] = useState<Record<string, boolean>>({})
  /** 防止同一分镜在 React 状态刷新前被重复触发 */
  const uploadTasks = useRef(new Set<string>())
  const [lib, setLib] = useState<ShotLibraryItem[]>([])
  /** 刚选完视频、还没拿到服务端封面时的本地缩略图（chooseMedia 的 thumbTempFilePath），用于即时预览 */
  const [localThumb, setLocalThumb] = useState<Record<string, string>>({})
  const [coverBusy, setCoverBusy] = useState(false)
  // 补生成封面只在每次进入页面时尝试一轮，避免与刷新互相触发
  const coverTried = useRef(false)
  /**
   * 进行中上传的取消句柄（分镜 id → abort）。
   * 离开页面时要主动中止：否则传输会在后台继续跑完，然后照常调用 /upload/complete
   * 落一条素材记录 —— 用户以为没传成功，数据里却多了一条。
   */
  const uploadAborters = useRef(new Map<string, () => void>())
  /** 页面已卸载标志：上传服务在各阶段之间检查它，命中后抛 UploadAbortedError 且不落库 */
  const pageGone = useRef(false)
  useEffect(() => () => {
    pageGone.current = true
    for (const abort of uploadAborters.current.values()) {
      try { abort() } catch { /* 任务已结束 */ }
    }
    uploadAborters.current.clear()
  }, [])

  useEffect(() => {
    Taro.setNavigationBarTitle({ title: '拍摄素材' })
  }, [])

  const load = useCallback(async () => {
    if (!id) return
    const d = await getCreation(id)
    setDetail(d)
    // 历史素材（本次改动前上传）没有封面：触发一次服务端补生成，成功后刷新详情
    const needCover = d.shots.some((s) => s.assetId && !s.coverUrl)
    if (needCover && !coverTried.current) {
      coverTried.current = true
      setCoverBusy(true)
      try {
        const r = await ensureShotCovers(id)
        if (r.generated > 0) setDetail(await getCreation(id))
      } catch {
        // 补封面失败不影响拍摄主流程
      } finally {
        setCoverBusy(false)
      }
    }
  }, [id])

  useEffect(() => {
    load()
    // 镜头库失败不阻断拍摄主流程
    listShotLibrary().then(setLib).catch(() => setLib([]))
  }, [load])

  // 按镜头分类（开场/口播/特写/原料/制作/环境/试吃/卖点/收尾）归组拍摄技巧，作为未匹配时的兜底
  const tipsByType = useMemo(() => {
    const m: Record<string, ShotLibraryItem[]> = {}
    for (const it of lib) {
      const list = m[it.category] ?? (m[it.category] = [])
      list.push(it)
    }
    return m
  }, [lib])

  // 优先展示 AI 为分镜匹配到的镜头库手法；未匹配时按镜头分类兜底
  const tipsFor = (shot: ShotItem): ShotLibraryItem[] => {
    if (shot.libraryShot) {
      return [{ ...shot.libraryShot, demoCoverKey: null, sort: 0 }]
    }
    return tipsByType[shot.shotType ?? ''] ?? []
  }

  const onUpload = async (shot: ShotItem) => {
    // 只锁当前分镜；其他分镜可以继续点「拍摄 / 选择视频」并发上传。
    // chooseMedia 期间也先占位，避免同一卡片被快速重复点击弹出多个选择器。
    if (uploadTasks.current.has(shot.id)) return
    uploadTasks.current.add(shot.id)
    setUploading((m) => ({ ...m, [shot.id]: true }))
    setProgress((m) => ({ ...m, [shot.id]: 0 }))
    try {
      const mediaRes = (await Taro.chooseMedia({
        count: 1,
        mediaType: ['video'],
        sourceType: ['album', 'camera'],
        maxDuration: 60,
      })) as unknown as {
        tempFiles: {
          tempFilePath: string
          /** 视频封面图临时路径（微信自带抽帧），本地模式不用、COS 模式随视频上报 */
          thumbTempFilePath?: string
          duration?: number
          size?: number
        }[]
      }
      const file = mediaRes.tempFiles[0]
      if (!file) return
      // 先本地占位，选完立刻能看到缩略图，不必等上传完成
      if (file.thumbTempFilePath) {
        setLocalThumb((m) => ({ ...m, [shot.id]: file.thumbTempFilePath! }))
      }
      const storeId = detail?.store?.id || ''
      const asset = await uploadVideoFile({
        filePath: file.tempFilePath,
        storeId,
        // duration 单位为秒；上报时长供后端按实际时长计价（未 trim 分镜的计费依据）
        durationMs: file.duration ? Math.round(file.duration * 1000) : undefined,
        sizeBytes: file.size,
        thumbFilePath: file.thumbTempFilePath,
        onProgress: (p) => setProgress((m) => ({ ...m, [shot.id]: p })),
        onTask: (task) => uploadAborters.current.set(shot.id, task.abort),
        isCancelled: () => pageGone.current,
      })
      const updated = await updateShotAsset(id!, shot.id, { assetId: asset.id })
      // 并发任务各自只回填自己的分镜，避免多个 load() 返回顺序不同、旧响应覆盖新绑定结果。
      setDetail((d) => d ? {
        ...d,
        shots: d.shots.map((s) => s.id === shot.id ? {
          ...s,
          ...updated,
          assetId: updated.assetId ?? asset.id,
          assetDurationMs: file.duration ? Math.round(file.duration * 1000) : s.assetDurationMs,
          coverUrl: file.thumbTempFilePath || s.coverUrl,
        } : s),
      } : d)
      Taro.showToast({ title: `分镜 ${shot.seq} 已绑定`, icon: 'success' })
      // 重新上传后允许页面下一次刷新时再尝试补封面（服务端抽帧失败时可重试）
      coverTried.current = false
    } catch (e: unknown) {
      // 页面已卸载导致的中止不算失败：既不该弹 toast，也不该在已卸载的组件上 setState
      if (e instanceof UploadAbortedError) return
      const err = e as { code?: number; errMsg?: string }
      // 用户取消选择不算失败；其他异常保留原错误层 toast，并补一条明确到分镜的提示。
      if (!/cancel/i.test(err?.errMsg ?? '') && err?.code !== 2001) {
        Taro.showToast({ title: `分镜 ${shot.seq} 上传失败`, icon: 'none' })
      }
    } finally {
      uploadAborters.current.delete(shot.id)
      uploadTasks.current.delete(shot.id)
      setUploading((m) => {
        const next = { ...m }
        delete next[shot.id]
        return next
      })
      setProgress((m) => {
        const next = { ...m }
        delete next[shot.id]
        return next
      })
    }
  }

  /** 点击缩略图播放原视频 */
  const previewAsset = async (shot: ShotItem) => {
    if (!shot.assetId) return
    try {
      const r = await getAssetPlayUrl(shot.assetId)
      if (!r.url) {
        Taro.showToast({ title: '暂无法播放该素材', icon: 'none' })
        return
      }
      await Taro.previewMedia({ sources: [{ url: r.url, type: 'video' }] })
    } catch {
      Taro.showToast({ title: '播放失败', icon: 'none' })
    }
  }

  const playDemo = async (item: ShotLibraryItem) => {
    if (!item.demoVideoKey) return
    try {
      const r = await getShotDemoPlayUrl(item.id)
      if (!r.url) {
        Taro.showToast({ title: '演示环境暂无示范视频', icon: 'none' })
        return
      }
      await Taro.previewMedia({ sources: [{ url: r.url, type: 'video' }] })
    } catch {
      Taro.showToast({ title: '播放失败', icon: 'none' })
    }
  }

  if (!detail) return <View className='cshots__tip'>加载中…<Button onClick={() => load().catch(() => undefined)}>重新加载</Button></View>
  const missingShots = detail.shots.filter((shot) => !shot.assetId)
  const total = detail.shots.length
  const done = total - missingShots.length
  const uploadingCount = Object.keys(uploading).length
  /** 有任意素材即可合成；全部补齐时显示主按钮，缺素材时显示「暂不上传」入口 */
  const canCompose = total > 0 && uploadingCount === 0

  return (
    <View className='cshots'>
      <View className='cshots__stage'>
        <Text className='cshots__stage-kicker'>STEP 3 OF 4 · SHOOTING</Text>
        <Text className='cshots__stage-title'>照着分镜，一条一条拍</Text>
        <Text className='cshots__stage-desc'>不必一次拍完，已上传的素材会自动保存。每个镜头都有现场拍摄提示。</Text>
      </View>

      {/* ── 整体进度 ── */}
      <View className='cshots__progress'>
        <View className='cshots__progress-head'>
          <Text className='cshots__progress-title'>拍摄进度</Text>
          <Text className='cshots__progress-num ds-num'>
            {done} / {total}
          </Text>
        </View>
        <ProgressLine
          percent={total ? (done / total) * 100 : 0}
          showValue={false}
          hint={
            uploadingCount > 0
              ? `${uploadingCount} 个素材正在同步上传，可继续选择其他分镜`
              : coverBusy
                ? '正在生成缩略图…'
                : missingShots.length > 0
                  ? `已上传 ${done} / ${total} 个分镜，缺 ${missingShots.length} 个素材也可先合成`
                  : '全部素材已上传，可以去合成成片'
          }
        />
      </View>

      {detail.shots.map((s) => {
        const tips = tipsFor(s)
        const thumbSrc = localThumb[s.id] || s.coverUrl || ''
        const isUploading = !!uploading[s.id]
        return (
          <View
            className={`cshots__card ${s.assetId ? '' : 'cshots__card--todo'}`}
            key={s.id}
          >
            <View className='cshots__head'>
              <Text className='cshots__seq'>{s.seq}</Text>
              <View className='cshots__headmain'>
                <Text className='cshots__type'>{s.shotType || '通用'}</Text>
                <View className='cshots__chips'>
                  {!!s.shotSize && <Text className='cshots__chip'>{s.shotSize}</Text>}
                  {!!s.durationSuggest && <Text className='cshots__chip'>建议 {s.durationSuggest}s</Text>}
                </View>
              </View>
              {!!s.assetId && <Text className='ds-pill ds-pill--green cshots__badge'>✓ 已上传</Text>}
            </View>

            {!!s.line && <Text className='cshots__line'>{s.line}</Text>}
            {!!s.visualReq && <Text className='cshots__visual'>画面：{s.visualReq}</Text>}

            {tips.length > 0 && (
              <View className='cshots__tips'>
                <View className='cshots__tipshead'>
                  <Text className='cshots__tipslabel'>怎么拍 · {tips[0].name}</Text>
                  {tips[0].demoVideoKey && (
                    <Text className='cshots__demo' onClick={() => playDemo(tips[0])}>看示范 ›</Text>
                  )}
                </View>
                <Text className='cshots__tipstext'>{tips[0].tips}</Text>
              </View>
            )}

            {isUploading && (
              <View className='cshots__uploading'>
                <ProgressLine percent={progress[s.id] || 0} label={`分镜 ${s.seq} 上传中`} />
              </View>
            )}

            {!!s.assetId && !isUploading && (
              <View className='cshots__media' onClick={() => previewAsset(s)}>
                {thumbSrc ? (
                  <Image className='cshots__thumb' mode='aspectFill' src={thumbSrc} />
                ) : (
                  <View className='cshots__thumbph'>
                    <Text className='cshots__thumbphtext'>缩略图生成中</Text>
                  </View>
                )}
                <View className='cshots__play' />
                {!!s.assetDurationMs && <Text className='cshots__dur ds-num'>{fmtDuration(s.assetDurationMs)}</Text>}
              </View>
            )}

            {!isUploading && (
              <View className='cshots__acts'>
                {!!s.assetId ? (
                  <Button className='cshots__btn cshots__btn--ghost' size='mini' onClick={() => onUpload(s)}>
                    重新拍摄
                  </Button>
                ) : (
                  <>
                    <View className='cshots__drop' hoverClass='ds-hover' onClick={() => onUpload(s)}>
                      <t-icon name='camera' size='48rpx' />
                      <Text className='cshots__drop-title'>拍摄 / 选择视频</Text>
                      <Text className='cshots__drop-sub'>
                        时长建议 {s.durationSuggest ? `${s.durationSuggest} 秒` : '1 分钟以内'}
                      </Text>
                    </View>
                    <Text
                      className='cshots__skip'
                      onClick={() =>
                        Taro.showModal({
                          title: '暂不上传该分镜',
                          content: '该分镜将使用系统默认占位素材，合成效果可能不理想。确定跳过？',
                          confirmText: '确定跳过',
                          confirmColor: '#8e939a',
                        }).then((r) => {
                          if (r.confirm) {
                            // 标记为跳过：本地状态置空 assetId，不实际上传
                            setDetail((d) =>
                              d
                                ? {
                                    ...d,
                                    shots: d.shots.map((shot) =>
                                      shot.id === s.id
                                        ? { ...shot, assetId: null, _skipped: true }
                                        : shot,
                                    ),
                                  }
                                : d,
                            )
                          }
                        })
                      }
                    >
                      暂不上传 ›
                    </Text>
                  </>
                )}
              </View>
            )}

            {!!s.assetId && !!s.assetDurationMs && !isUploading && (
              <Text className='cshots__note'>素材时长 {fmtDuration(s.assetDurationMs)} · 计费按实际时长</Text>
            )}
          </View>
        )
      })}

      <View className='ds-footer'>
        {canCompose ? (
          <Button
            className='ds-btn ds-btn--primary ds-btn--block'
            hoverClass='ds-hover'
            onClick={() => Taro.navigateTo({ url: `/pages/render/compose?id=${id}` })}
          >
            {missingShots.length === 0
              ? '下一步 · 合成成片'
              : `下一步 · 合成成片（缺 ${missingShots.length} 个素材）`}
          </Button>
        ) : (
          <Button className='ds-btn ds-btn--primary ds-btn--block ds-btn--disabled' disabled>
            {uploadingCount > 0
              ? `${uploadingCount} 个素材正在上传，请稍候…`
              : '加载中…'}
          </Button>
        )}
      </View>
    </View>
  )
}
