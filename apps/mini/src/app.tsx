import { type PropsWithChildren, useEffect } from 'react'
import Taro, { useLaunch } from '@tarojs/taro'
import { useMerchantStore } from './store/merchant'
import './styles/theme.scss'
import './app.scss'

function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    // 启动时恢复登录态（token 存本地 storage）
    useMerchantStore.getState().hydrate()
  })

  useEffect(() => {
    // ★ 必须挂在 onAppShow 上：useEffect([],) 只在 App 挂载时跑一次，而小程序
    //   切后台再回来（典型：跳微信支付完切回）不会重挂载 —— 积分余额就一直显示旧数字，
    //   恰是这里想避免的场景。onAppShow 每次回前台都触发。
    const refresh = () => {
      if (useMerchantStore.getState().token) {
        useMerchantStore.getState().refreshBean()
      }
    }
    Taro.onAppShow(refresh)
    refresh()
    return () => Taro.offAppShow(refresh)
  }, [])

  return children
}

export default App
