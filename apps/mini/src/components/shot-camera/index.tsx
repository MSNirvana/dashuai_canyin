// 自建拍摄层：全屏取景 + 提词器 + **点击**拍摄（取代微信原生的「长按录像」）
//
// ★ 为什么必须自建：Taro.chooseMedia 的 sourceType:'camera' 打开的是**微信客户端自己的**
//   拍摄界面，录像是**长按**触发的，小程序侧没有任何参数能改（只有 maxDuration）。
//   系统相机 App 也调不起来 —— 小程序沙箱不开放唤起其它 App（官方原话：
//   「微信未开放原生系统相机界面调用权限」）。要「点一下开始、再点一下停止」，
//   只能用 <Camera> 组件自己画界面。顺带把**提词器**做出来：界面归我们画，
//   分镜的台词（ShotItem.line）就能直接铺在取景画面上。
//
// ★ 自建相机与原生选择器有四处差异，都在下面补齐（少补一处就是静默算错钱或丢素材）：
//   1. stopRecord 只回 { tempVideoPath, tempThumbPath }，**没有 duration**
//      ⇒ 录制时长由本组件自己计时 —— 它同时是「按实际时长计价」的依据，不能省。
//   2. **没有 size** ⇒ 另外问一次文件系统；拿不到就留 undefined（上传侧按 0 处理，
//      服务端 sizeBytes 的校验是 min(0)，不会因此被拒）。
//   3. 「录制结束」有两条入口：用户点击 stopRecord，以及微信自己结束（到达 timeout 上限、
//      页面 onHide、录像异常退出）后回调 timeoutCallback。两条必须收敛到**同一个** finalize，
//      且只能收敛一次 —— 否则会凭空多出一条 take。
//   4. 原生选择器会顺手抽一张封面（thumbTempFilePath），自建相机是靠 tempThumbPath；
//      两者都必须往上传层传，否则素材列表没有缩略图。
//
// ★ 布局硬约束（微信官方文档）：同一页面只能有一个 camera；camera **不能**放进
//   scroll-view / swiper / picker-view / movable-view。所以这一层是整页 fixed 浮层，
//   内部不嵌套任何滚动容器（提词器用普通 View —— 分镜台词本来就只有十几个字）。
//   camera 是原生组件，默认层级最高，要靠**同层渲染**才能让上面的浮层盖住它：
//   官方现在说明「原生组件均已支持同层渲染，建议使用 view 替代」，所以这里用普通 View 画界面。

import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, Image, Camera } from '@tarojs/components'
import Taro from '@tarojs/taro'
import './index.scss'

/**
 * 录制上限（秒）。
 * 微信 startRecord 的 timeout 默认 30、官方上限 5 分钟；这里与原生选择器的
 * maxDuration 保持一致取 60 —— 分镜本来建议的都是十几秒，60 秒是上限而不是目标。
 */
export const SHOOT_MAX_SECONDS = 60

export interface ShotCameraResult {
  videoPath: string
  thumbPath?: string
  /** 录制时长（毫秒）。★ 自建相机拿不到 duration，由本组件计时 —— 它是计价依据 */
  durationMs: number
  /** 文件字节数；取不到则是 undefined */
  sizeBytes?: number
}

/** 提词器要用到的分镜字段（只取用得到的几个，避免把整个 ShotItem 拖进来） */
export interface ShotCameraShot {
  seq: number
  shotType?: string | null
  line?: string | null
  visualReq?: string | null
  durationSuggest?: number | null
}

interface Props {
  visible: boolean
  shot: ShotCameraShot | null
  /** 「怎么拍」的一句话（来自镜头库），有就补在提词器下面 */
  tipText?: string
  onCancel: () => void
  onDone: (r: ShotCameraResult) => void
  /**
   * 自建相机用不了（没有权限 / 没有摄像头 / 启动失败）。
   * ★ 调用方必须接住并回落到微信原生选择器 —— 否则用户在这一页就彻底拍不了。
   */
  onUnavailable: (reason: string) => void
}

/** 录制结束的两种来源（用户点击 / 微信自己结束）回给我们的都是这俩路径 */
interface RecordEndPayload {
  tempVideoPath?: string
  tempThumbPath?: string
}

/** Taro 的 CameraContext.StartRecordOption 类型里漏了 timeout（微信 2.22.0+ 才有），这里补上 */
interface StartRecordOptionWithTimeout {
  timeout?: number
  success?: () => void
  fail?: (e: unknown) => void
  timeoutCallback?: (res: RecordEndPayload) => void
}
interface StopRecordOptionLoose {
  success?: (r: RecordEndPayload) => void
  fail?: (e: unknown) => void
}

/** 00:12 形式的时钟（提词器/计时器用；与分镜卡片上的「分:秒」保持同一种读法） */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/** 微信的错误对象有时是 {errMsg}、有时是 Error（Taro 包了一层），两种都取 */
function errText(e: unknown): string {
  const o = e as { errMsg?: string; message?: string } | null | undefined
  return o?.errMsg || o?.message || ''
}

/**
 * 取本地文件字节数（自建相机拿不到 size，只能自己问文件系统）。
 * ① 先问 FileSystemManager（接口现成、类型完整）；
 * ② 再兜底顶层 Taro.getFileInfo（官方注释里指明它才是给**临时文件**用的那个）；
 * ③ 都拿不到就返回 undefined —— 上传侧会给 0，服务端 sizeBytes 是 min(0)，不会因此被拒。
 *    宁可 size 记 0，也不能为了拿这个数字把拍好的视频卡在这里。
 */
function readFileSize(filePath: string): Promise<number | undefined> {
  const pick = (r: unknown): number | undefined => {
    const n = (r as { size?: number } | null)?.size
    return typeof n === 'number' && n > 0 ? n : undefined
  }
  return new Promise<number | undefined>((resolve) => {
    try {
      Taro.getFileSystemManager().getFileInfo({
        filePath,
        success: (r) => resolve(pick(r)),
        fail: () => resolve(undefined),
      })
    } catch { resolve(undefined) }
  }).then((n) => {
    if (typeof n === 'number') return n
    return new Promise<number | undefined>((resolve) => {
      try {
        Taro.getFileInfo({
          filePath,
          success: (r) => resolve(pick(r)),
          fail: () => resolve(undefined),
        })
      } catch { resolve(undefined) }
    })
  })
}

/** CameraContext 收窄成我们实际用的两个方法（见 StartRecordOptionWithTimeout 的注释） */
function cameraCtx(): {
  startRecord: (o: StartRecordOptionWithTimeout) => void
  stopRecord: (o?: StopRecordOptionLoose) => void
} {
  return Taro.createCameraContext() as unknown as {
    startRecord: (o: StartRecordOptionWithTimeout) => void
    stopRecord: (o?: StopRecordOptionLoose) => void
  }
}

export default function ShotCamera({ visible, shot, tipText, onCancel, onDone, onUnavailable }: Props) {
  /** idle 取景待拍 / recording 录制中 / review 拍完待确认 */
  const [phase, setPhase] = useState<'idle' | 'recording' | 'review'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [device, setDevice] = useState<'front' | 'back'>('back')
  const [flash, setFlash] = useState<'off' | 'torch'>('off')
  const [take, setTake] = useState<ShotCameraResult | null>(null)
  /**
   * 相机层自己的问题（拒绝授权 / 没有摄像头 / 启停失败）。
   * ★ 一旦有值就**不再渲染 <Camera>**：渲染一个用不了的 camera 只会反复弹授权框，
   *   而用户需要的是一个能走出去的出口（去设置 / 回落原生）。
   */
  const [failMsg, setFailMsg] = useState('')

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startedAtRef = useRef(0)
  const elapsedRef = useRef(0)
  /** 停表时刻的时长：点击停止与微信自动结束都要先落到这里，finalize 只读不算 */
  const endedElapsedRef = useRef<number | null>(null)
  /** finalize 的幂等闸：两条结束入口 + 兜底自停，只能有一次真正生效 */
  const finalizedRef = useRef(false)
  const busyRef = useRef(false)

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }, [])

  // 关掉浮层（visible=false）时一定要停表：否则 interval 会在已卸载的组件上继续 setState
  useEffect(() => {
    if (!visible) return
    return () => { clearTimer() }
  }, [visible, clearTimer])

  // 每次重新打开都从「待拍」开始；device/flash 保留上次选择（用户多半要连拍同一机位）
  useEffect(() => {
    if (!visible) return
    setPhase('idle')
    setElapsed(0)
    setTake(null)
    setFailMsg('')
    startedAtRef.current = 0
    elapsedRef.current = 0
    endedElapsedRef.current = null
    finalizedRef.current = false
    busyRef.current = false
  }, [visible])

  // 预检相机授权：已明确拒绝过时直接给面板，别让 <Camera> 空转
  useEffect(() => {
    if (!visible) return
    let alive = true
    Taro.getSetting()
      .then((s) => {
        if (!alive) return
        const auth = (s.authSetting ?? {}) as Record<string, boolean>
        if (auth['scope.camera'] === false) setFailMsg('需要相机权限才能在这里拍摄')
      })
      .catch(() => { /* 读不到就交给 <Camera> 自己的授权弹窗 */ })
    return () => { alive = false }
  }, [visible])

  /**
   * 录制结束的唯一收敛点：用户点停、到达上限、被系统打断，最后都走这里。
   * ★ 幂等由 finalizedRef 保证；时长只读 endedElapsedRef，不在这里重新算 ——
   *   success 回调回来时已经过了一段编码落盘时间，在这里取 Date.now() 会把时长算长，
   *   而时长是计价依据。
   */
  const finalize = useCallback(async (res: RecordEndPayload) => {
    if (finalizedRef.current) return
    finalizedRef.current = true
    clearTimer()
    setPhase('idle')
    const videoPath = res.tempVideoPath
    if (!videoPath) {
      // 录像异常退出且微信没把文件交回来：不能假装成功，也不该把用户刚拍的那段默默丢掉
      setFailMsg('这次没有拿到录像文件，请再拍一次')
      return
    }
    const durationMs = endedElapsedRef.current ?? Math.max(0, elapsedRef.current)
    const sizeBytes = await readFileSize(videoPath)
    setTake({ videoPath, thumbPath: res.tempThumbPath, durationMs, sizeBytes })
    setPhase('review')
  }, [clearTimer])

  const doStop = useCallback(() => {
    if (finalizedRef.current) return
    endedElapsedRef.current = endedElapsedRef.current ?? Math.max(0, Date.now() - startedAtRef.current)
    cameraCtx().stopRecord({
      success: (r) => { void finalize(r) },
      fail: (e) => {
        // 停不下来最常见的原因是微信**已经**替我们结束了（刚好到上限）：
        // 那种情况 timeoutCallback 会带文件回来，这里不能抢先把状态清掉。
        if (finalizedRef.current) return
        clearTimer()
        setPhase('idle')
        setFailMsg(`停止录制失败：${errText(e) || '请再试一次'}`)
      },
    })
  }, [clearTimer, finalize])

  const doStart = useCallback(() => {
    if (busyRef.current) return
    busyRef.current = true
    startedAtRef.current = Date.now()
    elapsedRef.current = 0
    endedElapsedRef.current = null
    finalizedRef.current = false
    cameraCtx().startRecord({
      timeout: SHOOT_MAX_SECONDS,
      success: () => {
        busyRef.current = false
        setElapsed(0)
        setPhase('recording')
        clearTimer()
        timerRef.current = setInterval(() => {
          if (!startedAtRef.current) return
          const ms = Date.now() - startedAtRef.current
          elapsedRef.current = ms
          setElapsed(ms)
          // 兜底自停：微信到上限会回调 timeoutCallback，但万一没回调，界面会一直停在
          // 「录制中」而用户以为还在录。到点后我们自己收手（finalize 的幂等闸会挡住重复）。
          if (ms >= SHOOT_MAX_SECONDS * 1000 + 1200) {
            endedElapsedRef.current = endedElapsedRef.current ?? SHOOT_MAX_SECONDS * 1000
            doStop()
          }
        }, 200)
      },
      fail: (e) => {
        busyRef.current = false
        setFailMsg(`无法开始录制：${errText(e) || '请检查相机权限'}`)
      },
      // ★ 到达上限、页面 onHide、录像异常退出 —— 微信都从这里把文件交回来
      timeoutCallback: (r) => {
        endedElapsedRef.current = endedElapsedRef.current ?? Math.max(0, Date.now() - startedAtRef.current)
        void finalize(r)
      },
    })
  }, [clearTimer, doStop, finalize])

  const toggleRecord = useCallback(() => {
    if (phase === 'recording') doStop()
    else if (phase === 'idle') doStart()
  }, [phase, doStart, doStop])

  /** 回到取景重新拍：把上一条的痕迹清干净，否则 finalizedRef 会把下一次录制直接吞掉 */
  const retake = useCallback(() => {
    setTake(null)
    setFailMsg('')
    setElapsed(0)
    startedAtRef.current = 0
    elapsedRef.current = 0
    endedElapsedRef.current = null
    finalizedRef.current = false
    setPhase('idle')
  }, [])

  const close = async () => {
    if (phase === 'recording') {
      const r = await Taro.showModal({
        title: '正在录制',
        content: '现在离开会丢掉这一段。',
        confirmText: '离开',
        cancelText: '继续拍',
        confirmColor: '#d54941',
      })
      if (!r.confirm) return
      try { cameraCtx().stopRecord({}) } catch { /* 放弃这一段，停不下来也不影响离开 */ }
      clearTimer()
    }
    onCancel()
  }

  const goSetting = async () => {
    try {
      const r = await Taro.openSetting()
      const auth = (r.authSetting ?? {}) as Record<string, boolean>
      if (auth['scope.camera']) { retake(); return }
      Taro.showToast({ title: '还没允许使用相机', icon: 'none' })
    } catch {
      Taro.showToast({ title: '打开设置失败，可从右上角「…」进设置', icon: 'none' })
    }
  }

  if (!visible) return null

  const recording = phase === 'recording'
  const line = (shot?.line ?? '').trim()
  const visual = (shot?.visualReq ?? '').trim()
  // 提词器字号按台词长度分三档：分镜台词通常十几字，长台词要主动缩一号才不会占掉半个屏幕
  const lineSize = !line ? '' : line.length <= 20 ? 'shotcam__line--xl' : line.length <= 40 ? 'shotcam__line--lg' : 'shotcam__line--md'

  return (
    <View className='shotcam' catchMove>
      {/* 取景层。★ 有 failMsg 时不挂 <Camera>（见 failMsg 的注释） */}
      {!failMsg && (
        <Camera
          className='shotcam__preview'
          devicePosition={device}
          flash={flash}
          resolution='high'
          onError={(e) => setFailMsg(`相机不可用：${errText(e.detail) || '请检查权限'}`)}
          onStop={() => {
            // 摄像头被非正常终止（切后台、被系统抢占）。正在录的话微信会走
            // timeoutCallback 把文件交回来，这里只负责把界面从「录制中」摘出来，
            // 别让它一直停在录制态骗用户。
            if (recording) { clearTimer(); setPhase('idle') }
          }}
        />
      )}

      {!failMsg && phase !== 'review' && (
        <View className='shotcam__ui'>
          <View className='shotcam__top'>
            <Text className='shotcam__close' onClick={() => void close()}>✕</Text>
            <Text className='shotcam__seq'>
              分镜 {shot?.seq ?? ''}{shot?.shotType ? ` · ${shot.shotType}` : ''}
            </Text>
            {/* 切前后摄只能在开录前：录到一半换摄像头会把这一段废掉 */}
            {!recording ? (
              <Text
                className='shotcam__tool'
                onClick={() => setDevice((d) => (d === 'back' ? 'front' : 'back'))}
              >
                {device === 'back' ? '前置' : '后置'}
              </Text>
            ) : <Text className='shotcam__tool shotcam__tool--off'>·</Text>}
          </View>

          {/* ── 提词器：贴着上方（靠近镜头），念稿时视线不离取景框 ── */}
          {(!!line || !!visual || !!tipText) && (
            <View className='shotcam__prompt'>
              {!!line && <Text className={`shotcam__line ${lineSize}`}>{line}</Text>}
              {!!visual && <Text className='shotcam__visual'>画面：{visual}</Text>}
              {!!tipText && <Text className='shotcam__tip'>{tipText}</Text>}
            </View>
          )}

          <View className='shotcam__spacer' />

          <View className='shotcam__bottom'>
            <View className='shotcam__metarow'>
              <Text className='shotcam__timer ds-num'>
                {fmtClock(recording ? elapsed : 0)} / {fmtClock(SHOOT_MAX_SECONDS * 1000)}
              </Text>
              <Text
                className='shotcam__tool'
                onClick={() => setFlash((f) => (f === 'off' ? 'torch' : 'off'))}
              >
                补光 {flash === 'torch' ? '开' : '关'}
              </Text>
            </View>

            <View className='shotcam__shutterwrap' onClick={toggleRecord}>
              <View className={`shotcam__shutter ${recording ? 'shotcam__shutter--on' : ''}`} />
            </View>

            <Text className='shotcam__hint'>
              {recording
                ? '点一下停止'
                : shot?.durationSuggest
                  ? `点一下开始 · 这一段建议 ${shot.durationSuggest} 秒`
                  : '点一下开始录，再点一下停'}
            </Text>
          </View>
        </View>
      )}

      {/* ── 拍完确认：把封面和时长摆出来，让用户决定用不用 ── */}
      {phase === 'review' && !!take && (
        <View className='shotcam__panel'>
          {take.thumbPath
            ? <Image className='shotcam__reviewthumb' mode='aspectFill' src={take.thumbPath} />
            : <View className='shotcam__reviewthumb shotcam__reviewthumb--ph' />}
          <Text className='shotcam__paneltitle'>拍好了 · {fmtClock(take.durationMs)}</Text>
          <Text className='shotcam__panelsub'>确认后开始上传，上传时可以先拍别的分镜</Text>
          <View className='shotcam__panelacts'>
            <Text className='shotcam__btn' onClick={retake}>重拍</Text>
            <Text className='shotcam__btn shotcam__btn--main' onClick={() => { if (take) onDone(take) }}>
              用这条
            </Text>
          </View>
        </View>
      )}

      {/* ── 相机用不了：两个出口（去设置 / 回落微信原生），不能把用户困在这一层 ── */}
      {!!failMsg && (
        <View className='shotcam__panel'>
          <Text className='shotcam__paneltitle'>{failMsg}</Text>
          <Text className='shotcam__panelsub'>也可以先用微信原生的拍/选继续这一条</Text>
          <View className='shotcam__panelacts'>
            <Text className='shotcam__btn' onClick={() => void goSetting()}>去设置里允许</Text>
            <Text
              className='shotcam__btn shotcam__btn--main'
              onClick={() => { clearTimer(); onUnavailable(failMsg) }}
            >
              用微信原生的
            </Text>
          </View>
          <Text className='shotcam__retry' onClick={retake}>再试一次</Text>
        </View>
      )}
    </View>
  )
}
