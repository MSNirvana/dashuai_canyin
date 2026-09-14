// iOS 分段控件：取代原生 Picker，用于文案款式 / 镜头复杂度 / 订阅·加油包
// 选中即生效，无需二次确认
//
// 用法：<Segmented options={[{value:'A',label:'流量款'}]} value={track} onChange={setTrack} />

import { View, Text } from '@tarojs/components'
import './index.scss'

export interface SegmentedOption {
  value: string
  label: string
}

interface Props {
  options: SegmentedOption[]
  value: string
  onChange: (value: string) => void
  /** 外层附加类名 */
  className?: string
  /** 是否撑满整行（默认 true） */
  block?: boolean
}

export default function Segmented({ options, value, onChange, className = '', block = true }: Props) {
  return (
    <View className={`segmented ${block ? 'segmented--block' : ''} ${className}`}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <View
            key={o.value}
            className={`segmented__item ${on ? 'segmented__item--on' : ''}`}
            hoverClass={on ? 'none' : 'segmented__item--hover'}
            onClick={() => {
              if (!on) onChange(o.value)
            }}
          >
            <Text className='segmented__label'>{o.label}</Text>
          </View>
        )
      })}
    </View>
  )
}
