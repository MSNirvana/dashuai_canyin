// 列表项左滑操作：内容区左滑后右侧露出操作按钮（归档/删除、恢复/删除）。
//
// 为什么不引 tdesign 的 swipe-cell：
//   它需要往产物 npm/ 里补一个组件目录（连带依赖闭包），而本项目对 npm 依赖是**按需逐目录
//   拷贝**的，漏一个隐藏依赖的后果是「构建成功但页面白屏」。这里只要"左滑露出按钮"这一点
//   交互，用 touch 事件自己实现更小、更可控。
//
// 展开状态由父组件**受控**，不是组件内部状态 —— 这样才能保证「同一时间最多只展开一行」。
//
// 用法：
//   <SwipeActions
//     actions={[{ key: 'archive', label: '归档', onClick: () => onArchive(c.id) }]}
//     open={openId === c.id}
//     onOpenChange={(o) => setOpenId(o ? c.id : '')}
//     onClick={() => onOpen(c.id)}
//   >
//     ...卡片内容
//   </SwipeActions>

import { useRef } from 'react'
import { View, Text } from '@tarojs/components'
import type { ITouchEvent } from '@tarojs/components'
import './index.scss'

export interface SwipeAction {
  key: string
  label: string
  /** 危险操作（删除）标红 */
  danger?: boolean
  onClick: () => void
}

interface Props {
  actions: SwipeAction[]
  /** 是否展开（受控） */
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 点击内容区（本次手势被判定为滑动时不会触发） */
  onClick?: () => void
  /** 外层附加类名，用来补页面级的圆角 / 间距 / 阴影 */
  className?: string
  children: React.ReactNode
}

/** 单个操作按钮宽度（px）。宽度由 JS 传给 inline style，避免和 scss 两处写死不一致 */
const ACTION_W = 76
/** 触发展开 / 收起的最小横向位移：太小会把手指抖动当成滑动 */
const TRIGGER = 28

export default function SwipeActions({ actions, open, onOpenChange, onClick, className = '', children }: Props) {
  const start = useRef<{ x: number; y: number } | null>(null)
  // 本次手势是否被判为横向滑动。点击回调要看它 —— 否则「滑完抬手」会顺带触发进详情。
  // 必须在 touchStart 重置：滑动后不一定再收到 click，留 true 会把下一次正常点击吞掉。
  const swiped = useRef(false)

  // 动作是**上下堆叠的一列**（归档在上、删除在下），露出的宽度就是单个按钮宽度，
  // 不是 count × 宽度 —— 后者是横向并排时的算法。
  const width = ACTION_W

  const onTouchStart = (e: ITouchEvent) => {
    const t = e.touches[0]
    if (!t) return
    start.current = { x: t.clientX, y: t.clientY }
    swiped.current = false
  }

  const onTouchEnd = (e: ITouchEvent) => {
    const s = start.current
    start.current = null
    if (!s) return
    const t = e.changedTouches[0]
    if (!t) return
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    // 纵向手势一律让给页面滚动：列表要能正常上下滑
    if (Math.abs(dy) > Math.abs(dx)) return
    if (Math.abs(dx) < TRIGGER) return
    swiped.current = true
    onOpenChange(dx < 0)
  }

  return (
    <View className={`swipe ${className}`}>
      <View className='swipe__actions' style={{ width: `${width}px` }}>
        {actions.map((a) => (
          <View
            key={a.key}
            className={`swipe__action ${a.danger ? 'swipe__action--danger' : ''}`}
            style={{ width: `${ACTION_W}px` }}
            hoverClass='swipe__action--hover'
            onClick={() => {
              onOpenChange(false)
              a.onClick()
            }}
          >
            <Text className='swipe__action-text'>{a.label}</Text>
          </View>
        ))}
      </View>

      <View
        className='swipe__body'
        style={open ? { transform: `translateX(-${width}px)` } : undefined}
        // Taro 把 View 的 touch 事件声明成了通用 CommonEventFunction（入参不含 touches），
        // 但运行时给的就是触摸事件 ⇒ 这里断言一次，handler 内部才拿得到 clientX/clientY。
        onTouchStart={(e) => onTouchStart(e as unknown as ITouchEvent)}
        onTouchEnd={(e) => onTouchEnd(e as unknown as ITouchEvent)}
        onClick={() => {
          if (swiped.current) {
            swiped.current = false
            return
          }
          // 已展开时，第一下点击先收起 —— 直接进详情属于误触
          if (open) {
            onOpenChange(false)
            return
          }
          onClick?.()
        }}
      >
        {children}
      </View>
    </View>
  )
}
