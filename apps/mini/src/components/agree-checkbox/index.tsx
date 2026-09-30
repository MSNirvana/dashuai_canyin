import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import './index.scss'

/**
 * 隐私政策同意勾选框（**主动勾选**，不是默认同意）。
 *
 * ★★ 为什么必须是可勾选的、且默认**不勾**：
 *   登录弹窗原来那句「授权即表示同意《用户协议》和《隐私政策》」是**默示同意** ——
 *   用户只要点了登录按钮就算同意了（点之前也可以压根没看见）。而《个人信息保护法》
 *   与微信的隐私合规要求是**取得明示同意**：用户要能自主阅读、自主选择是否同意。
 *   所以同意状态必须由用户**主动勾选**产生，且每次重新发起登录都要回到「未勾选」。
 *
 * ★ 只有**方框**是可点区，右侧文字不可点。
 *   看着少了一点热区，但这是刻意的：右侧那句里嵌着两个协议链接，
 *   若整行都可点，点《用户协议》时事件会冒泡到父级 ⇒ **看协议反而把框勾上了**，
 *   等于替用户做了决定。宁可热区小一点，也不要一个会误解的勾。
 *   （方框本身用「padding + 等量负 margin」把热区撑到 72rpx，视觉位置不变。）
 *
 * ★ 不传 `onOpenDoc` 时默认跳 `pages/agreement/index?type=`。
 *   两个登录入口（「我的」登录弹窗、订单中心页内登录）共用本组件 ——
 *   ★★ 同一件事两处各写一份必然漂移，这台机器上已经踩过好几次了。
 */
export interface AgreeCheckboxProps {
  checked: boolean
  onChange: (next: boolean) => void
  /** 自定义打开协议的方式；不传则跳内置协议页 */
  onOpenDoc?: (type: 'user' | 'privacy') => void
  /** 前缀文案，默认「我已阅读并同意」 */
  label?: string
}

export default function AgreeCheckbox({
  checked,
  onChange,
  onOpenDoc,
  label = '我已阅读并同意',
}: AgreeCheckboxProps) {
  const openDoc = (type: 'user' | 'privacy') => {
    if (onOpenDoc) {
      onOpenDoc(type)
      return
    }
    // 与「我的」页原有的 go() 同款：接住返回的 Promise，否则失败会以
    // 「未处理的 Promise 拒绝」冒到 App.onError，控制台里只剩一句看不懂的栈。
    Taro.navigateTo({ url: `/pages/agreement/index?type=${type}`, fail: () => undefined }).catch(
      () => undefined,
    )
  }

  return (
    <View className='agreebox'>
      <View className='agreebox__hit' onClick={() => onChange(!checked)}>
        <View className={`agreebox__box${checked ? ' is-checked' : ''}`}>
          {checked && <t-icon name='check' size='20rpx' color='#ffffff' />}
        </View>
      </View>
      <View className='agreebox__text'>
        <Text>{label}</Text>
        <Text className='agreebox__link' onClick={() => openDoc('user')}>
          《用户协议》
        </Text>
        <Text>和</Text>
        <Text className='agreebox__link' onClick={() => openDoc('privacy')}>
          《隐私政策》
        </Text>
      </View>
    </View>
  )
}
