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

  /**
   * ★ 这里**只能**返回 children（外加 Provider）。
   *
   * 曾经试过在这层加一个「全局弹窗」兄弟节点（`{children}<GuideDialogHost/>`），
   * 结论是**小程序端根本不会渲染**，已撤回。依据在 Taro 运行时里：
   *   · 页面数据里的所有路径都以 `root` 为根 —— `@tarojs/runtime` 的
   *     `findCustomWrapper(root, dataPathArr)` 第一句就是 `dataPathArr.slice(1)`（删掉 `root`）。
   *   · `createPageConfig` 的 ONLOAD 里只做 `pageElement.performUpdate()`，
   *     同步的是**页面元素自己的子树**。
   *   ⇒ 与页面同级的兄弟节点在 app 树里存在，却不在任何页面的 `root` 里，端上没有对应模板数据。
   * 需要全局/跨页的 UI，请挂在**页面**里（见 `components/guide-dialog/index.tsx` 的挂载说明）。
   */
  return children
}

export default App
