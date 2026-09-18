import { Loading } from 'tdesign-react'

/**
 * 路由级懒加载的兜底占位。
 *
 * 后台各页面已改为 `React.lazy` 动态 import（见 App.tsx 顶部注释），首次进入某个页面时
 * 需要先下载那一小块 JS，这段时间 `<Suspense>` 会渲染这里。
 *
 * 设计取舍：
 * · **不做全屏遮罩**（不用 `Loading` 的 fullscreen/attach 形态）：页面代码只是在下载，
 *   左侧菜单和顶栏是好的，把它们盖住反而像「整站卡死」。只占内容区。
 * · 高度给足（240px）避免内容区高度塌陷、下载完成后页面高度跳一下。
 */
export default function RouteFallback() {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 240,
      }}
    >
      <Loading text="加载中…" />
    </div>
  )
}
