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
import { readRouteId } from '../../utils/route-id'
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
  // 编号当场校验：非法编号（最典型的是字符串 'undefined'）不能直接拿去发请求，
  // 否则本页只会永远停在「加载中…」，而点「下一步」跳到合成页后收到的是服务端那句
  // 指向不了任何操作的「参数不合法」（详见 utils/route-id.ts）。
  const id = readRouteId(Taro.getCurrentInstance().router?.params as Record<string, unknown> | undefined)
  const [detail, setDetail] = useState<CreationDetail | null>(null)
  /** 加载失败（含「编号丢失」）时的可读原因：绝不能只留一句「加载中…」吊着用户 */
  const [loadError, setLoadError] = useState('')
  const [progress, setProgress] = useState<Record<string, number>>({})
  /** 各分镜独立上传状态：允许多个素材并发上传，不再用单个 shotId 锁住整页 */
  const [uploading, setUploading] = useState<Record<string, boolean>>({})
  /** 防止同一分镜在 React 状态刷新前被重复触发 */
  const uploadTasks = useRef(new Set<string>())
  /** 正在提交「跳过 / 撤销跳过」的分镜：挡住重复点击，也让按钮能有反馈 */
  const [skipping, setSkipping] = useState<Record<string, boolean>>({})
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
    if (!id) { setLoadError('页面编号丢失，请回到「创作」重新进入'); return }
    setLoadError('')
    try {
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
    } catch (error) {
      // ★ 必须在这里接住。本页原来是把 load() 裸调出去的（没有 catch），
      //   请求一失败就是未处理的 Promise rejection：detail 永远为 null，
      //   页面永远停在「加载中…」，用户看不出是失败还是慢（已实测踩到）。
      setLoadError((error as Error).message || '加载失败，请重试')
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

  /**
   * 「暂不上传」——把跳过**落库**，而不是只改本地 state。
   *
   * ★ 为什么必须发请求：合成页是按「分镜有没有 assetId」判断素材是否齐全的。
   *   跳过只写在页面 state 里的话，一刷新就没了（换设备更不用说），
   *   用户点了「确定跳过」、走到合成页，却仍然被「请先补齐全部分镜素材」挡住 ——
   *   而那个分镜他本来就打算不拍。这是个**死循环**：回去再点一次跳过，还是被挡。
   *
   * ★ 文案必须与真实行为一致：跳过 = 这个分镜**不会出现在成片里**（合成管线按分镜取素材，
   *   没有素材的分镜不进片），**也不计费**（计价按各分镜素材时长累加）。
   *   原来写的是「将使用系统默认占位素材」—— 服务端根本没有占位素材这回事，
   *   从 ChatCut 到本地 ffmpeg 都要真实字节，等于对用户许了一个做不到的承诺。
   */
  const onSkip = async (shot: ShotItem) => {
    if (!id || skipping[shot.id]) return
    const r = await Taro.showModal({
      title: '跳过这个分镜',
      content: '不会出现在成片里，也不会计费。',
      confirmText: '确定跳过',
      confirmColor: '#8e939a',
    })
    if (!r.confirm) return
    await patchSkip(shot, true)
  }

  /** 撤销跳过：把它恢复成「待上传」。素材本来就没有，所以只是把标记清掉 */
  const onUnskip = async (shot: ShotItem) => {
    if (!id || skipping[shot.id]) return
    await patchSkip(shot, false)
  }

  const patchSkip = async (shot: ShotItem, skipped: boolean) => {
    if (!id) return
    setSkipping((m) => ({ ...m, [shot.id]: true }))
    try {
      const updated = await updateShotAsset(id, shot.id, { skipped })
      // 只回填这一个分镜：其他分镜可能有并发上传正在写自己的结果，
      // 整体替换 detail 会把它们的中间态覆盖掉
      setDetail((d) =>
        d ? { ...d, shots: d.shots.map((s) => (s.id === shot.id ? { ...s, ...updated } : s)) } : d,
      )
      Taro.showToast({ title: skipped ? '已跳过该分镜' : '已恢复，记得补拍', icon: 'none' })
    } catch (error) {
      // 失败必须说出来：静默失败的话，用户以为跳过了，到合成页还是被挡，又回到那个死循环
      Taro.showToast({ title: (error as Error).message || '操作失败，请重试', icon: 'none' })
    } finally {
      setSkipping((m) => {
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

  /**
   * 上一步：回「创作」页重新生成文案与分镜。
   * 按视图栈里的创作页实例回退（同一创作可能在栈中间：创作 → 拍摄 → 成片 → 拍摄），
   * 找不到时才新开一个 —— 直接 navigateBack 有可能退到成片页，或退到别的创作的创作页。
   */
  const onBack = () => {
    const routes = (Taro.getCurrentPages() as unknown as { route?: string }[]).map((p) => p.route)
    const idx = routes.lastIndexOf('pages/creation/edit')
    if (idx >= 0 && idx < routes.length - 1) {
      Taro.navigateBack({ delta: routes.length - 1 - idx })
      return
    }
    if (!id) {
      Taro.showToast({ title: '编号丢失，请重新进入', icon: 'none' })
      return
    }
    Taro.navigateTo({ url: `/pages/creation/edit?id=${id}` })
  }

  /**
   * 下一步 → 合成成片。**编号必须落进 URL**，拿不到就不跳。
   * 拼出 `?id=undefined` 的话，合成页会拿这个字符串去请求，只换来一句
   * 「参数不合法」—— 用户完全不知道该做什么（已实测复现）。
   */
  const navToCompose = () => {
    if (!id) {
      Taro.showToast({ title: '编号丢失，请重新进入', icon: 'none' })
      return
    }
    Taro.navigateTo({ url: `/pages/render/compose?id=${id}` })
  }

  // 编号丢了就给唯一的真出路（回列表重进）；有编号才给「重新加载」。
  if (!detail) {
    return (
      <View className='cshots__tip'>
        {loadError || '加载中…'}
        {!!loadError &&
          (id ? (
            <Button onClick={() => load()}>重新加载</Button>
          ) : (
            <Button onClick={() => Taro.switchTab({ url: '/pages/creation/list' })}>回到创作列表</Button>
          ))}
      </View>
    )
  }
  /**
   * 「缺素材」= 既没有 assetId、**也没有被明确跳过**的分镜。
   * ★ 漏掉 `!shot.skipped` 的话，跳过就完全没效果：进度条永远显示缺一个，
   *   「建议补拍」的提示也永远挂着，用户以为自己的操作没生效。
   */
  const missingShots = detail.shots.filter((shot) => !shot.assetId && !shot.skipped)
  const skippedCount = detail.shots.filter((shot) => shot.skipped).length
  const total = detail.shots.length
  /** 真正传了素材的分镜数（跳过的不算）—— 它就是计价与成片内容的来源 */
  const uploadedCount = detail.shots.filter((shot) => !!shot.assetId).length
  const done = total - missingShots.length
  const uploadingCount = Object.keys(uploading).length
  /**
   * 有任意素材即可合成；全部补齐时显示主按钮，缺素材时显示「暂不上传」入口。
   * ★ `uploadedCount > 0` 是硬底线：一个素材都没有时服务端必然回 4003
   *   （buildRenderClips「clips.length === 0 ⇒ RenderNoAssetError」），
   *   而成片本来就是由各分镜素材拼出来的 —— 放行只会让用户白点一次、拿一句报错回来。
   *   最容易踩到这个的是「把每个分镜都点了跳过」：那一刻页面上没有任何「缺素材」提示，
   *   于是按钮看起来是通的。
   */
  const canCompose = total > 0 && uploadingCount === 0 && uploadedCount > 0
  /** 分镜的四种状态在卡片上的文案（跳过的卡片不该再显示「还没拍」的红色提醒） */
  const cardState = (s: ShotItem) => (s.assetId ? 'ready' : s.skipped ? 'skipped' : 'todo')

  return (
    <View className='cshots'>
      <View className='cshots__stage'>
        <Text className='cshots__stage-kicker'>STEP 2 OF 3 · SHOOTING</Text>
        <Text className='cshots__stage-title'>照着分镜，一条一条拍</Text>
        <Text className='cshots__stage-desc'>不必一次拍完，已上传的素材会自动保存。每个镜头都有现场拍摄提示。</Text>
        {/* ★★ 全局拍摄方向提示（2026-09-22 加）。
            成片画布固定 9:16，而云端适配用的是 `fit:"cover"`（填满画布、不留黑边）——
            横屏素材想填满竖屏画布只能**放大 3.5 倍再裁掉左右两侧**，只剩画面正中一条。
            线上真实事故：用户交上来的是「只剩一张脸的特写」。
            而 18 条镜头提示里**只有 2 条**提到竖拍 ⇒ 用户老老实实照着提示拍完，素材还是横的。
            ★ 方向这件事必须在**开拍之前**说，而且只在页面顶部说一次：
              每条卡片都重复一遍就成了噪音，重复的警示等于没有警示。 */}
        <View className='cshots__orient'>
          <Text className='cshots__orient-title'>全程竖屏拍摄（手机竖着拿）</Text>
          <Text className='cshots__orient-desc'>
            成片是 9:16 竖屏。横着拍的素材只能裁掉左右两边来填满画面，人会变成大特写。
          </Text>
        </View>
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
                : uploadedCount === 0
                  ? skippedCount > 0
                    ? `全部分镜都被跳过了，至少要拍 1 个才能合成`
                    : '还没有上传任何素材'
                  : missingShots.length > 0
                    ? `已上传 ${uploadedCount} / ${total} 个分镜，缺 ${missingShots.length} 个素材也可先合成`
                    : skippedCount > 0
                      ? `已上传 ${uploadedCount} / ${total} 个分镜，另有 ${skippedCount} 个已跳过`
                      : '全部素材已上传，可以去合成成片'
          }
        />
      </View>

      {detail.shots.map((s) => {
        const tips = tipsFor(s)
        const thumbSrc = localThumb[s.id] || s.coverUrl || ''
        const isUploading = !!uploading[s.id]
        const state = cardState(s)
        return (
          <View
            // 跳过的卡片不再走「待办」的强调边框 —— 它已经不是待办了
            className={`cshots__card ${state === 'todo' ? 'cshots__card--todo' : ''} ${state === 'skipped' ? 'cshots__card--skipped' : ''}`}
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
              {state === 'ready' && <Text className='ds-pill ds-pill--green cshots__badge'>✓ 已上传</Text>}
              {state === 'skipped' && <Text className='ds-pill ds-pill--gray cshots__badge'>已跳过</Text>}
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
                      <Text className='cshots__drop-title'>{s.skipped ? '补拍这个分镜' : '拍摄 / 选择视频'}</Text>
                      <Text className='cshots__drop-sub'>
                        {s.skipped
                          ? '已跳过，不会被合成进成片'
                          : `时长建议 ${s.durationSuggest ? `${s.durationSuggest} 秒` : '1 分钟以内'}`}
                      </Text>
                    </View>
                    <Text
                      className='cshots__skip'
                      onClick={() => void (s.skipped ? onUnskip(s) : onSkip(s))}
                    >
                      {skipping[s.id] ? '处理中…' : s.skipped ? '撤销跳过 ›' : '暂不上传 ›'}
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
        <View className='ds-footer__row'>
          <Button className='ds-btn ds-btn--ghost ds-btn--sm' hoverClass='ds-hover' onClick={onBack}>
            上一步
          </Button>
          <Button
            className={`ds-btn ds-btn--primary ds-btn--block ${canCompose ? '' : 'ds-btn--disabled'}`}
            hoverClass='ds-hover'
            disabled={!canCompose}
            onClick={navToCompose}
          >
            下一步
          </Button>
        </View>
        <View className='ds-footer__note'>
          {uploadingCount > 0
            ? `${uploadingCount} 个素材正在上传，完成后即可合成`
            : total === 0
              ? '还没有分镜，回上一步生成文案与分镜'
              : uploadedCount === 0
                ? '至少上传 1 个分镜的素材才能合成'
                : missingShots.length > 0
                  ? `已上传 ${uploadedCount}/${total}，仍缺 ${missingShots.length} 个也可先合成${
                      skippedCount > 0 ? `（另有 ${skippedCount} 个已跳过，不进成片）` : ''
                    }`
                  : skippedCount > 0
                    ? `素材已齐，其中 ${skippedCount} 个已跳过，不会进成片`
                    : '素材已齐，可以合成成片了'}
        </View>
      </View>
    </View>
  )
}
