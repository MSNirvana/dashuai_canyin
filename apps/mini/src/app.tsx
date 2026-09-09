import { type PropsWithChildren, useEffect } from 'react'
import { useLaunch } from '@tarojs/taro'
import { useMerchantStore } from './store/merchant'
import './styles/theme.scss'
import './app.scss'

function App({ children }: PropsWithChildren) {
  useLaunch(() => {
    // 启动时恢复登录态（token 存本地 storage）
    useMerchantStore.getState().hydrate()
  })

  useEffect(() => {
    // 每次进前台刷新豆余额，避免展示过期数据
    const refresh = () => {
      if (useMerchantStore.getState().token) {
        useMerchantStore.getState().refreshBean()
      }
    }
    refresh()
  }, [])

  return children
}

export default App
