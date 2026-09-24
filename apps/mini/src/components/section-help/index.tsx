// 标题右侧的小问号：把「常驻在版面上的小字解释」收进一个按需查看的弹窗。
//
// 为什么做成组件而不是每页各写一套：创作全流程三页（创作/拍摄/合成）都要用同一形态，
// 分散实现必然漂移（大小不一、行为不一）。弹窗用 Taro.showModal —— 与合成页
// 「积分怎么算」那个既有问号弹窗同一交互，用户不需要学第二种打开方式。
//
// ★ stopPropagation：问号常常落在可点的标题行/卡片里，不拦会把弹窗和跳转一起触发
//   （weapp 里 stopPropagation 不可靠的说法针对的是「拦不住原生冒泡」的个别场景，
//   Taro 组件树内合成事件的拦截是可靠的 —— 本项目多处已在用同一写法）。
import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import './index.scss'

interface Props {
  /** 弹窗标题：一般就是它旁边那个区块的标题 */
  title: string
  /** 说明正文（弹窗 content） */
  text: string
}

export default function SectionHelp({ title, text }: Props) {
  return (
    <View
      className='section-help'
      hoverClass='ds-hover'
      onClick={(e) => {
        e.stopPropagation()
        void Taro.showModal({ title, content: text, showCancel: false, confirmText: '知道了' })
      }}
    >
      <Text>?</Text>
    </View>
  )
}
