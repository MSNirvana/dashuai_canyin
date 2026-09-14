// 四步流程条：让用户始终知道「我在第几步、还剩几步」
// 用法：<Steps steps={['文案','分镜','素材','成片']} current={1} />  current 从 0 开始

import { Fragment } from 'react'
import { View, Text } from '@tarojs/components'
import './index.scss'

interface Props {
  steps: string[]
  /** 当前步骤下标，从 0 开始 */
  current: number
  className?: string
}

export default function Steps({ steps, current, className = '' }: Props) {
  return (
    <View className={`steps ${className}`}>
      {steps.map((label, i) => {
        const done = i < current
        const on = i === current
        return (
          <Fragment key={label}>
            <View className={`steps__item ${on ? 'steps__item--on' : ''} ${done ? 'steps__item--done' : ''}`}>
              <View className='steps__dot'>
                {done ? <Text className='steps__check'>✓</Text> : <Text className='steps__num'>{i + 1}</Text>}
              </View>
              <Text className='steps__label'>{label}</Text>
            </View>
            {i < steps.length - 1 && <View className={`steps__line ${done ? 'steps__line--on' : ''}`} />}
          </Fragment>
        )
      })}
    </View>
  )
}
