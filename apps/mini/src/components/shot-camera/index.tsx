// 自建拍摄层：**全屏**取景 + 提词器 + **点击**拍摄（取代微信原生的「长按录像」）
//
// ★ 为什么必须自建：Taro.chooseMedia 的 sourceType:'camera' 打开的是**微信客户端自己的**
//   拍摄界面，录像是**长按**触发的，小程序侧没有任何参数能改（只有 maxDuration）。
//   系统相机 App 也调不起来 —— 小程序沙箱不开放唤起其它 App（官方原话：
//   「微信未开放原生系统相机界面调用权限」）。要「点一下开始、再点一下停止」，
//   只能用 <Camera> 组件自己画界面。顺带把**提词器**做出来：界面归我们画，
//   分镜的台词（ShotItem.line）就能直接铺在取景画面上。
//
// ★★ 界面必须用 <cover-view>，不能用普通 View —— 这是两次真机翻车换来的结论：
//   1. 取景画面要**占满屏幕**，控件就必然压在 camera 的矩形上；
//   2. camera 是客户端创建的原生组件，官方原文「它的层级是最高的，不能通过 z-index
//      控制层级」，而**同层渲染在真机上会失败**（官方 bindrendererror 注释：
//      Android 缺少同层渲染内核 / iOS 页面节点树不稳定）。一旦失败，叠在它矩形上的
//      普通 View 就收不到点击 —— 表现是整层控件（前后摄、补光、快门）一起点不动；
//   3. cover-view 是官方为「覆盖在原生组件之上」提供的组件（本仓首页那个盖在 <video>
//      上的「收起」按钮就是同一套路）。cover-view 里只能放 cover-view / cover-image，
//      所以这里的文字全用 CoverView，布局一律绝对定位（它不吃 flex）。
//   ⇒ 改这一层之前先读这段：**普通 View 不要往取景画面上放**。只有等 camera 已经卸载的
//     时候（拍完确认 / 相机不可用两块面板）才可以用普通 View。
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
// ★★ 还有一条平台脾气：startRecord / stopRecord 会「success、fail 一个都不回调」
//   （官方社区多例，其中一例就是用 Taro 调 createCameraContext；安卓另有相机渲染
//   异步导致的 `camera has not been initalized`）。所以**界面状态绝不挂在 success 上**：
//   点击即进入录制态、立即走表；回调只用来纠正 / 重锚；两条调用都配看门狗兜底。
//   这一条是「点了录制没有计时 + 再也点不了停止」的直接原因，改前必读 doStart / doStop。
//
// ★ 布局硬约束（微信官方文档）：同一页面只能有一个 camera；camera **不能**放进
//   scroll-view / swiper / picker-view / movable-view。所以这一层是整页 fixed 浮层，
//   内部不嵌套任何滚动容器（提词器用 CoverView —— 分镜台词本来就只有十几个字）。

import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, Image, Camera, CoverView } from '@tarojs/components'
import Taro from '@tarojs/taro'
import './index.scss'

/**
 * 录制上限（秒）。
 * 微信 startRecord 的 timeout 默认 30、官方上限 5 分钟；这里与原生选择器的
 * maxDuration 保持一致取 60 —— 分镜本来建议的都是十几秒，60 秒是上限而不是目标。
 */
export const SHOOT_MAX_SECONDS = 60

/**
 * 等 stopRecord 把文件交回来的上限（毫秒）。
 * 它要等编码落盘，本来就慢，所以给得宽一点；但**必须有这个上限** ——
 * stopRecord 也可能一个回调都不来（平台已知问题），没有上限用户就永远停在「正在保存…」。
 */
const STOP_ACK_TIMEOUT_MS = 8000

/**
 * 「相机尚未初始化」的重试间隔（毫秒）。
 * 安卓的相机渲染是异步的，startRecord 偶尔会撞上 `camera has not been initalized`。
 * 这是瞬时竞态，隔一拍重试一次就过 —— 别为它弹面板，否则用户以为相机坏了。
 */
const START_RETRY_DELAY_MS = 700

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
  /**
   * 「怎么拍」的一句话（来自镜头库）。
   * ★ 2026-09-28 按需求从取景层撤掉：屏幕上只留「口播文案 + 画面文案」，别的都不要。
   *   字段先留着是为了**不动调用方**（pages/creation/shots.tsx 那一行属于另一条未提交的
   *   改动线，不该被这次改动捆进去）。下次清理时连调用方那一行一起删。
   */
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

export default function ShotCamera({ visible, shot, onCancel, onDone, onUnavailable }: Props) {
  /** idle 取景待拍 / recording 录制中 / review 拍完待确认 */
  const [phase, setPhase] = useState<'idle' | 'recording' | 'review'>('idle')
  const [elapsed, setElapsed] = useState(0)
  /**
   * 点了停止、正在等文件落盘的那一小段（stopRecord 要等编码完成才回调。
   * ★ 有它用户才知道「点停有反应了」，也顺手挡住这段时间里的重复点击。
   */
  const [saving, setSaving] = useState(false)
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
  /** stopRecord 的看门狗：它不回调时靠它把界面放出来（见 doStop） */
  const stopWatchRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startedAtRef = useRef(0)
  const elapsedRef = useRef(0)
  /** 停表时刻的时长：点击停止与微信自动结束都要先落到这里，finalize 只读不算 */
  const endedElapsedRef = useRef<number | null>(null)
  /** finalize 的幂等闸：两条结束入口 + 兜底自停，只能有一次真正生效 */
  const finalizedRef = useRef(false)
  /**
   * ★★ 录制态用 ref 做**同步**判断，`phase` 只管渲染：连点两下快门时两次 click 读到的
   *   `phase` 都是旧值（setState 是异步的），只靠它挡不住第二次 startRecord。
   */
  const recordingRef = useRef(false)
  /** 点了停止、正等文件落盘：这期间的点击必须被挡住（同上是同步判断） */
  const savingRef = useRef(false)
  /**
   * ★★ 「录制代次」：`resetRun` 每清一次场就 +1，startRecord / stopRecord 的回调在**发出
   *   那一刻**把当时的代次闭包进去，回来时先对一下代次 —— 对不上说明这一轮已经被用户
   *   放弃（重拍 / 交棒 / 关掉浮层）了。
   *   为什么必须有它：这两个回调在真机上会**迟很多拍**才回来（平台已知问题）。没有它，
   *   上一段的 stopRecord 回来时会把**上一段的文件**当成刚拍好的这一段填进 take。
   */
  const epochRef = useRef(0)

  const clearTimer = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
  }, [])

  /**
   * 把「这一条录制」的运行时痕迹全部清干净：计时器、看门狗、幂等闸、录制/保存标记。
   * ★ 三处都要用（关闭浮层、重新打开、重拍），漏掉哪一处都会留下一条「卡住的」状态。
   * ★ 注意它会把 finalizedRef 置回 false —— 所以 **finalize 内部不能调它**，
   *   那些字段在 finalize 里逐个显式处理（见 finalize）。
   */
  const resetRun = useCallback(() => {
    clearTimer()
    if (stopWatchRef.current) { clearTimeout(stopWatchRef.current); stopWatchRef.current = null }
    startedAtRef.current = 0
    elapsedRef.current = 0
    endedElapsedRef.current = null
    finalizedRef.current = false
    recordingRef.current = false
    savingRef.current = false
    // ★ 代次 +1：在飞的那两个回调（startRecord / stopRecord）从此对不上号，一律丢弃
    epochRef.current += 1
  }, [clearTimer])

  // 关掉浮层（visible=false）时一定要停表：否则 interval 会在已卸载的组件上继续 setState。
  // 看门狗同理 —— 它到点也会 setState。
  useEffect(() => {
    if (!visible) return
    return () => { resetRun() }
  }, [visible, resetRun])

  // 每次重新打开都从「待拍」开始；device/flash 保留上次选择（用户多半要连拍同一机位）
  useEffect(() => {
    if (!visible) return
    resetRun()
    setPhase('idle')
    setElapsed(0)
    setSaving(false)
    setTake(null)
    setFailMsg('')
  }, [visible, resetRun])

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
    recordingRef.current = false
    savingRef.current = false
    clearTimer()
    if (stopWatchRef.current) { clearTimeout(stopWatchRef.current); stopWatchRef.current = null }
    setSaving(false)
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
    if (!recordingRef.current || finalizedRef.current) return
    // ★ 记下「这一轮」的代次：下面两个回调迟回来时若对不上，说明用户已经重拍 / 关掉了，
    //   那个文件不能再算作刚拍好的这一段（见 epochRef ★★）。
    const ep = epochRef.current
    recordingRef.current = false
    endedElapsedRef.current = endedElapsedRef.current ?? Math.max(0, Date.now() - startedAtRef.current)
    clearTimer()
    // 立刻离开「录制中」并进入「正在保存」：点停要有即时反馈，也顺手挡住重复点击
    setPhase('idle')
    savingRef.current = true
    setSaving(true)
    /** 只收一次口：看门狗与真回调都可能到，谁先到谁生效 */
    const give = (msg: string) => {
      if (epochRef.current !== ep || finalizedRef.current || !savingRef.current) return
      savingRef.current = false
      setSaving(false)
      setFailMsg(msg)
    }
    /* ★★ 看门狗：stopRecord 也会「success、fail 一个都不回调」（平台已知问题）。
       没有它，用户就永远停在「正在保存…」—— 那就是「点不了停止」。
       等到这个上限还没消息，就自己收手并给一句能行动的提示。 */
    stopWatchRef.current = setTimeout(
      () => give('这段录像没保存成功，请再拍一次'),
      STOP_ACK_TIMEOUT_MS,
    )
    try {
      cameraCtx().stopRecord({
        success: (r) => { if (epochRef.current !== ep) return; void finalize(r) },
        fail: (e) => {
          // 停不下来最常见的原因是微信**已经**替我们结束了（刚好到上限）：
          // 那种情况 timeoutCallback 会带文件回来，这里不能抢先把状态清掉。
          if (epochRef.current !== ep || finalizedRef.current) return
          give(`停止录制失败：${errText(e) || '请再试一次'}`)
        },
      })
    } catch (e) {
      // cameraCtx() 本身也可能抛（上下文拿不到）：同样要收口，绝不能把界面留死
      give(`停止录制失败：${errText(e) || '请再试一次'}`)
    }
  }, [clearTimer, finalize])

  const doStart = useCallback(() => {
    if (recordingRef.current || savingRef.current) return
    // ★ 这一轮的代次（见 epochRef ★★）：startRecord 的回调也要认它，否则「已经重拍的
    //   上一轮」迟回来的 timeoutCallback 会把文件填进来，把这一轮正在录的顶掉。
    const ep = epochRef.current
    recordingRef.current = true
    startedAtRef.current = Date.now()
    elapsedRef.current = 0
    endedElapsedRef.current = null
    finalizedRef.current = false
    setElapsed(0)
    setPhase('recording')
    /* ★★ 不等 success 就进录制态、立刻走表。
       startRecord 在真机上会「success、fail 一个都不回调」（官方社区多例）。把进入录制态
       挂在 success 上的话，用户看到的就是「点了没反应、没有计时」，而且旧实现里那个
       busyRef 会一直被占着 —— 于是「再也点不了停止」。回调现在只用来纠正和重锚。 */
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

    /** 撤销录制态。只有 fail（或 startRecord 直接抛）才走这里 */
    const abort = (e: unknown) => {
      if (epochRef.current !== ep || !recordingRef.current) return
      recordingRef.current = false
      clearTimer()
      setPhase('idle')
      setFailMsg(`无法开始录制：${errText(e) || '请检查相机权限'}`)
    }

    const fire = (retried: boolean) => {
      if (epochRef.current !== ep) return
      try {
        cameraCtx().startRecord({
          timeout: SHOOT_MAX_SECONDS,
          success: () => {
            // ★ 用 success 的时刻**重锚**开始时间：录制是这一刻才真正开始的。
            //   时长是计价依据，不能把 startRecord 的调用/相机初始化延迟算进去。
            //   ★ 只做重锚，**不靠它进录制态** —— 它在真机上根本不回调（见上面 ★★）。
            if (epochRef.current !== ep) return
            startedAtRef.current = Date.now()
            elapsedRef.current = 0
          },
          fail: (e) => {
            if (epochRef.current !== ep) return
            // 安卓的相机渲染是异步的，偶发「camera has not been initalized」（官方社区）。
            // 这是瞬时竞态：隔一拍重试一次就过，别直接弹面板把用户挡回去。
            if (!retried && /init|initaliz|初始化/i.test(errText(e))) {
              setTimeout(() => { if (recordingRef.current) fire(true) }, START_RETRY_DELAY_MS)
              return
            }
            abort(e)
          },
          // ★ 到达上限、页面 onHide、录像异常退出 —— 微信都从这里把文件交回来
          timeoutCallback: (r) => {
            if (epochRef.current !== ep) return
            endedElapsedRef.current = endedElapsedRef.current ?? Math.max(0, Date.now() - startedAtRef.current)
            void finalize(r)
          },
        })
      } catch (e) {
        // cameraCtx() 本身可能抛：这里不收口的话录制态和计时器会一起留在那儿
        abort(e)
      }
    }
    fire(false)
  }, [clearTimer, doStop, finalize])

  const toggleRecord = useCallback(() => {
    // ★ 用 recordingRef 而不是 phase：连点两下时 phase 还是旧值，挡不住第二次 startRecord
    if (recordingRef.current) doStop()
    else doStart()
  }, [doStart, doStop])

  /**
   * 切前端 / 后置。
   * ★ 顺手把补光关掉：`flash='torch'` 是**后置**闪光灯，前置没有闪光灯，带着 'torch' 切过去
   *   在部分机型上会让相机**直接渲染失败**（那时会弹「相机不可用」，看着像相机坏了）。
   * ★ 真正让画面翻转靠的是渲染时那个 `key={`${device}-${flash}`}`（重建节点），
   *   这里的 setState 只是先把参数摆好。
   */
  const switchDevice = () => {
    const next = device === 'back' ? 'front' : 'back'
    if (next === 'front' && flash !== 'off') setFlash('off')
    setDevice(next)
  }

  /** 回到取景重新拍：把上一条的痕迹清干净，否则 finalizedRef 会把下一次录制直接吞掉 */
  const retake = useCallback(() => {
    resetRun()
    setTake(null)
    setFailMsg('')
    setElapsed(0)
    setSaving(false)
    setPhase('idle')
  }, [resetRun])

  const close = async () => {
    if (recordingRef.current) {
      const r = await Taro.showModal({
        title: '正在录制',
        content: '现在离开会丢掉这一段。',
        confirmText: '离开',
        cancelText: '继续拍',
        confirmColor: '#d54941',
      })
      if (!r.confirm) return
      try { cameraCtx().stopRecord({}) } catch { /* 放弃这一段，停不下来也不影响离开 */ }
    }
    // 走人之前把所有运行时痕迹清干净（含 stopRecord 的看门狗与「正在保存」标记）
    resetRun()
    setSaving(false)
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

  /**
   * 交棒给「微信原生的拍/选」：关掉浮层之前先把这一层的运行痕迹全部按住。
   * ★ 必须走 resetRun（而不是只 clearTimer）：它会把看门狗停掉、把代次 +1，
   *   否则这段在飞的 stopRecord 回调会在交棒之后把文件填回来，改一个已经交出去的状态。
   */
  const handoff = () => {
    resetRun()
    setSaving(false)
    onUnavailable(failMsg)
  }

  if (!visible) return null

  const recording = phase === 'recording'
  /**
   * ★★ 只在「正在取景」时才挂 <Camera>。拍完确认（review）与相机不可用（failMsg）两块
   * 面板都是**居中**的、用的是普通 View —— 普通 View 盖不住还活着的 camera（native 组件的
   * 层级最高）。所以进这两态之前先把 camera 卸掉，面板上的按钮才点得到；
   * 这也是 43454fa 里「面板同样点不动」的同一条根因（见 index.scss 文件头 ★★）。
   */
  const showCamera = !failMsg && phase !== 'review'
  const line = (shot?.line ?? '').trim()
  const visual = (shot?.visualReq ?? '').trim()
  // cover-view 的默认样式是 white-space: nowrap，长台词会被**静默裁掉**（不换行、不报错）。
  // 所以字号必须跟着字数下台阶，保证整句排得进一行 —— 这是「排得下」的硬要求，不是美观。
  const lineSize = !line
    ? ''
    : line.length <= 11 ? 'shotcam__promptline--s1'
      : line.length <= 16 ? 'shotcam__promptline--s2'
        : 'shotcam__promptline--s3'

  return (
    <View className='shotcam' catchMove>
      {/* ── 取景画面：**整屏铺满**。它必须和下面的 UI 层**平级** —— camera 是客户端创建的
          原生组件，层级最高、z-index 管不了它，只能靠 cover-view 盖上去（见文件头 ★★）。 */}
      {showCamera && (
        <Camera
          /* ★ key 里带上 device/flash：camera 的 device-position 在部分机型上
             动态改不生效（实测点「前置」画面不动），换 key 强制重建最稳。
             重建只在开录前发生 —— 录制中两个开关都是禁用的。 */
          key={`${device}-${flash}`}
          className='shotcam__preview'
          devicePosition={device}
          flash={flash}
          resolution='high'
          onError={(e) => setFailMsg(`相机不可用：${errText(e.detail) || '请检查权限'}`)}
          onStop={() => {
            // 摄像头被非正常终止（切后台、被系统抢占）。正在录的话微信会走
            // timeoutCallback 把文件交回来，这里只负责把界面从「录制中」摘出来，
            // 别让它一直停在录制态骗用户。
            // ★ 判据用 recordingRef 而不是渲染里的 recording：这个回调可能早于 setState 落地。
            if (recordingRef.current) { recordingRef.current = false; clearTimer(); setPhase('idle') }
          }}
        />
      )}

      {/* ★★ 立体 UI 层：**必须是 CoverView**。普通 View 压在全屏 camera 上要靠同层渲染，
          真机上会失败 —— 一失败就是「前后摄、快门」几条一起点不动（见文件头 ★★）。
          cover-view 不吃 flex、默认 nowrap，所以这一层里**一律绝对定位**（见 scss）。
          ★ 屏幕上只留两条文案：口播文案（大，要念的）+ 画面文案（小，要拍到的）。 */}
      {showCamera && (
        <CoverView className='shotcam__ui'>
          {/* 关闭。✕ 是符号不是文案 */}
          <CoverView className='shotcam__close' onClick={() => void close()}>✕</CoverView>

          {/* 切前后摄只能在开录前：录到一半换摄像头会把这一段废掉。
              ★ 用户这轮说「其他文案不要」，但这一条必须留 —— 它就是上一轮
                「前置和后置摄像头点了没反应」那个需求本身，删掉就退回去了。 */}
          {!recording && !saving && (
            <CoverView
              className='shotcam__tool shotcam__tool--device'
              onClick={switchDevice}
            >
              {device === 'back' ? '前置' : '后置'}
            </CoverView>
          )}

          {/* 补光：**只在后置时给**。前置摄像头没有闪光灯，`flash='torch'` 在它身上必然无效
              —— 上一轮「补光也没有用」就是这么来的，不是坏了。
              控件本身不带字（这轮只许留两条文案），用亮 / 灭的小圆点表示开与关。 */}
          {!recording && !saving && device === 'back' && (
            <CoverView
              className={`shotcam__tool shotcam__tool--flash ${flash === 'torch' ? 'shotcam__tool--flash-on' : ''}`}
              onClick={() => setFlash((f) => (f === 'off' ? 'torch' : 'off'))}
            />
          )}

          {/* ★ 这两条文案直接**浮在取景画面上**：「分镜 N · 类型」「建议 N 秒」
              「点一下开始 / 点一下停止」「补光 开 / 关」全部撤掉。 */}
          <CoverView className='shotcam__prompt'>
            {!!line && <CoverView className={`shotcam__promptline ${lineSize}`}>{line}</CoverView>}
            {!!visual && <CoverView className='shotcam__promptvisual'>{visual}</CoverView>}
          </CoverView>

          {/* 录制计时：**居中大字**。读的是 startedAtRef 的真时间差（由 200ms 的 interval 推），
              不是旧实现里那个「永远 00:00」的假值 —— 旧值只在 startRecord 的 success 里才更新，
              而那个 success 在真机上根本不回调（见 doStart ★★）。 */}
          {/* 录制指示：一个红点（符号不是文案）。有了它，「正在录」这件事一眼可见，
              计时器随它一起出现 —— 整屏只有这两样东西在录的时候发生变化。 */}
          {recording && <CoverView className='shotcam__recdot'>●</CoverView>}
          {recording && (
            <CoverView className='shotcam__bigtime ds-num'>{fmtClock(elapsed)}</CoverView>
          )}

          {/* 快门：待拍 = 实心圆；录制中 = 收成圆角方块（就是「点一下停止」的那个停止符）。
              ★ 点一下即切态，不等 startRecord 的回调（见 doStart ★★）。 */}
          {!saving && (
            <CoverView className='shotcam__shutterwrap' onClick={toggleRecord}>
              <CoverView className={`shotcam__shutter ${recording ? 'shotcam__shutter--on' : ''}`} />
            </CoverView>
          )}

          {/* 点停之后的等待段：stopRecord 要等编码落盘才能把文件交回来。
              ★★ **故意不给它 onClick**：这一段里文件已经在写盘，后到的回调还会回填 take，
                 让用户在这里「放弃」只会把状态机搅乱（放弃之后回调再来一次，界面会莫名
                 其妙跳回确认页）。它最多停 STOP_ACK_TIMEOUT_MS，到点由看门狗收口（见 doStop）。 */}
          {saving && (
            <CoverView className='shotcam__wait'>
              <CoverView className='shotcam__waittitle'>正在保存这一条…</CoverView>
              <CoverView className='shotcam__waitsub ds-num'>
                {fmtClock(endedElapsedRef.current ?? elapsed)}
              </CoverView>
            </CoverView>
          )}
        </CoverView>
      )}

      {/* ── 拍完确认：把封面和时长摆出来，让用户决定用不用 ──
          ★ 这一块用**普通 View**：走到这里 camera 已经卸载（showCamera=false），
            没有原生组件要盖，普通 View 反而好写（能吃 flex、能换行）。 */}
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
              onClick={handoff}
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
