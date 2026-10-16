/**
 * 通用「一句解释 + 两颗按钮」弹窗（自绘）。
 *
 * ★★ 为什么要自绘，而不是继续用 `Taro.showModal`（微信原生弹窗）：
 *
 *   微信的 `wx.showModal` 参数只有 title / content / showCancel / cancelText / cancelColor /
 *   confirmText / confirmColor / editable / placeholderText —— **content 是纯字符串**，
 *   官方没有给任何样式能力（无富文本、无字号入参）。所以「正文以外再来一行**小字**」
 *   这件事，原生弹窗从根上做不到，只能自己画。见 `utils/login-guide.ts` 的 `note` 档。
 *
 *   ★ 反过来也要说清楚：**不需要小字/富文本的弹窗，仍然应该用 `showModal`**。
 *     它由客户端渲染，永远在最上层、不占我们的包体与渲染开销。本组件不是要取而代之。
 *
 * ★ 挂载点：**挂在要用它的页面里**（`<GuideDialogHost />` 放进页面根节点），不要挂到 `app.tsx`。
 *   试过挂 `app.tsx`，小程序端**不渲染**：Taro 的页面数据路径一律以 `root` 为根
 *   （`@tarojs/runtime` 的 `findCustomWrapper(root, dataPathArr)` 第一句就是 `dataPathArr.slice(1)`，
 *   删掉的正是 `root`），而 `createPageConfig` 的 ONLOAD 只做 `pageElement.performUpdate()`，
 *   同步的是**页面元素自己的子树** ⇒ App 里与页面同级的兄弟节点不在任何页面的 `root` 里。
 *   ★ 没挂 Host 的页面不会静默失效：`openGuideDialog` 会降级回原生 `Taro.showModal`
 *     （代价只是那一行小字没了），见下面的 hostCount。
 *
 * ★ 现有挂载点：`pages/home/index.tsx`、`pages/work/detail.tsx`（即当前 3 个 guideLogin 调用点）。
 *   新页面要弹这层，把 `<GuideDialogHost />` 加进页面根节点即可。
 *
 * ★ 层级：这里用的是**普通 View**，靠**同层渲染**盖住 `video` 等原生组件。
 *   官方《原生组件说明》原文：「当前所有原生组件（除 input 组件 focus 状态）均已支持同层渲染」
 *   「同层渲染下已无以下限制」；`cover-view` 文档更是直接写「目前原生组件均已支持同层渲染，
 *   **建议使用 view 替代**」。
 *   ⇒ 不用 cover-view 是**故意的**：cover-view 只支持定位/布局/文本样式，**不吃 flex**
 *     （见 `components/shot-camera/index.scss` 的文件头实测），做不出「居中 + 圆角 + 投影」的卡片。
 *     shot-camera 那边必须用 cover-view，是因为它盖的是**全屏 camera**且取景框要 1:1 贴合，
 *     那是另一个场景，别把结论搬过来。
 */
import { useCallback, useEffect, useState } from 'react'
import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import './index.scss'

export interface GuideDialogOptions {
  /** 标题，例如「登录后可用」 */
  title: string
  /** 正文一句话，要说清**为什么**，例如「开始创作需要先登录」 */
  content: string
  /** 确认按钮文案，默认「确定」 */
  confirmText?: string
  /** 取消按钮文案，默认「取消」 */
  cancelText?: string
  /** 确认按钮文字色，默认品牌红 */
  confirmColor?: string
  /**
   * ★ 正文/按钮之外的一行**小字**，占在卡片最底部。
   *   这是本组件存在的唯一理由 —— 原生弹窗给不了这一档（见文件头 ★★）。
   */
  note?: string
  onConfirm?: () => void
  onCancel?: () => void
}

/** 内部状态比入参多一个 seq：同一次打开要能触发重渲染，且能分辨「新开的一次」 */
type GuideDialogState = (GuideDialogOptions & { seq: number }) | null

// ───────────────────────── 模块级单例（不引状态库：全局只需要一个弹窗） ─────────────────────────

let current: GuideDialogState = null
let seq = 0
/**
 * 当前存活了几个 `<GuideDialogHost />`（跟着页面挂载/卸载增减）。
 * 0 ⇒ 这个页面没挂 Host，自绘弹窗无处渲染 —— 这时**必须降级**，
 * 否则调用方点了按钮什么都不发生，比「少一行小字」糟得多。
 */
let hostCount = 0
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((listener) => listener())
}

/** 打开弹窗。同一时刻只会有一个：后开的直接顶掉先开的 */
export function openGuideDialog(options: GuideDialogOptions): void {
  if (hostCount === 0) {
    // 降级：原生弹窗。`note` 只能并进 content 当普通一行（原生 content 是纯字符串，给不了字号）
    void Taro.showModal({
      title: options.title,
      content: options.note ? `${options.content}\n${options.note}` : options.content,
      confirmText: options.confirmText ?? '确定',
      cancelText: options.cancelText ?? '取消',
      confirmColor: options.confirmColor ?? '#e1251b',
    }).then((result) => {
      if (result.confirm) options.onConfirm?.()
    })
    return
  }
  current = { ...options, seq: ++seq }
  notify()
}

/** 关掉当前弹窗（**不会**触发 onConfirm / onCancel，供程序复位用） */
export function closeGuideDialog(): void {
  if (!current) return
  current = null
  notify()
}

/**
 * 页面订阅「当前有没有弹窗」。
 * 用途：页面上带着原生组件（首页播放中的 `<Video>`）时，弹窗前先把它们收掉，
 * 免得同层渲染在个别机型上失手、卡片被视频压住（`pages/home/index.tsx` 的用法）。
 */
export function useGuideDialogVisible(): boolean {
  const [visible, setVisible] = useState(() => current !== null)
  useEffect(() => {
    const listener = () => setVisible(current !== null)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return visible
}

/** 弹窗实例：放进**页面根节点**（见文件头 ★ 挂载点；挂 app.tsx 无效） */
export function GuideDialogHost() {
  const [state, setState] = useState<GuideDialogState>(() => current)
  useEffect(() => {
    const listener = () => setState(current)
    listeners.add(listener)
    // 登记「本页有自绘弹窗可用」；卸载时撤销，`openGuideDialog` 靠它决定是否降级
    hostCount += 1
    return () => {
      listeners.delete(listener)
      hostCount -= 1
    }
  }, [])

  // ★ 先关窗、再执行回调：回调里通常会 navigateTo/switchTab，
  //   若不先关，旧页面被切走时这层 fixed 浮层会跟着「留在原地」一小会儿。
  const handleCancel = useCallback(() => {
    const callback = current?.onCancel
    closeGuideDialog()
    callback?.()
  }, [])
  const handleConfirm = useCallback(() => {
    const callback = current?.onConfirm
    closeGuideDialog()
    callback?.()
  }, [])

  if (!state) return null

  return (
    <View className='guide-dialog'>
      {/* 遮罩纯装饰、不吃点击：微信原生弹窗也不支持点遮罩关闭，这里保持一致，
          免得用户误触把「去登录」这一步给点没了 */}
      <View className='guide-dialog__mask' />
      <View className='guide-dialog__card'>
        <Text className='guide-dialog__title'>{state.title}</Text>
        <Text className='guide-dialog__desc'>{state.content}</Text>
        <View className='guide-dialog__actions'>
          <View
            className='guide-dialog__btn guide-dialog__btn--cancel'
            hoverClass='ds-hover'
            onClick={handleCancel}
          >
            {state.cancelText ?? '取消'}
          </View>
          <View
            className='guide-dialog__btn guide-dialog__btn--confirm'
            style={{ color: state.confirmColor ?? '#e1251b' }}
            hoverClass='ds-hover'
            onClick={handleConfirm}
          >
            {state.confirmText ?? '确定'}
          </View>
        </View>
        {!!state.note && <Text className='guide-dialog__note'>{state.note}</Text>}
      </View>
    </View>
  )
}
