// 红色细进度条：用于 AI 生成 / 视频上传 / 成片合成
// 统一「进度条 + 百分比 + 文案」，禁止无反馈的转圈
//
// 用法：<ProgressLine percent={62} label='成片合成中' hint='预计还需 2 分钟' />

import { View, Text } from '@tarojs/components'
import './index.scss'

interface Props {
  /** 0 - 100 */
  percent: number
  /** 左侧说明文案 */
  label?: string
  /** 右侧补充说明（如预计耗时） */
  hint?: string
  /** 是否显示百分比数字（默认 true） */
  showValue?: boolean
  className?: string
}

export default function ProgressLine({ percent, label, hint, showValue = true, className = '' }: Props) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)))
  return (
    <View className={`pline ${className}`}>
      {(label || showValue) && (
        <View className='pline__head'>
          {!!label && <Text className='pline__label'>{label}</Text>}
          <View className='pline__spacer' />
          {showValue && <Text className='pline__value'>{pct}%</Text>}
        </View>
      )}
      <View className='pline__track'>
        <View className='pline__fill' style={{ width: `${pct}%` }} />
      </View>
      {!!hint && <Text className='pline__hint'>{hint}</Text>}
    </View>
  )
}
