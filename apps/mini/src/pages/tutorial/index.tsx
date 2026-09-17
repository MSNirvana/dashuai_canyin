import { useEffect, useRef, useState } from 'react'
import { View, Text, Video } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import {
  TUTORIAL_CATEGORIES,
  listTutorials,
  tutorialCategoryOf,
  type TutorialItem,
} from '../../services/tutorial'
import './index.scss'

/** 播放器节点 id —— createVideoContext 靠它定位，改名要同步改播放/全屏两处 */
const VIDEO_ID = 'tutorial-video'

const videoCtx = () => Taro.createVideoContext(VIDEO_ID)

/**
 * 教学中心 · 分类课程页（`/pages/tutorial/index?category=SHOOTING`）。
 *
 * 布局照参考样式：顶部一块深色「舞台」放播放器（右下角一个全屏按钮），
 * 下面是白色圆角列表，点列表项**就地**切换播放，不做二次跳转。
 *
 * ── 两个刻意的取舍 ───────────────────────────────────────────────────────
 * 1) 导航栏保持**白色**，只有视频区是深色。参考 App 是全站深色主题，深色导航在它那里
 *    是自然的；本工具全站是白底卡片风，单独一页换黑导航会突兀。
 * 2) 切课才自动播：`autoplay` 只在用户点过列表之后才为 true，
 *    否则一进页面就外放声音。首屏永远是「等用户按播放」。
 */
export default function TutorialPage() {
  const router = useRouter()
  // 大小写不敏感：这个参数是各入口手拼出来的，不指望调用方一定大写
  const code = String(router.params.category ?? 'SHOOTING').toUpperCase()
  const meta = tutorialCategoryOf(code) ?? TUTORIAL_CATEGORIES[0]

  const [items, setItems] = useState<TutorialItem[]>([])
  const [current, setCurrent] = useState<TutorialItem | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  /** 重试计数：改它就重跑下面的 effect（比在按钮里复制一遍请求干净） */
  const [reloadTick, setReloadTick] = useState(0)
  /** 用户是否点过列表项。没点过就不 autoplay，避免一进页面就出声 */
  const userPicked = useRef(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadError('')
    listTutorials(meta.code)
      .then((r) => {
        if (!alive) return
        setItems(r.items)
        setCurrent(r.items[0] ?? null)
      })
      .catch((e) => {
        if (alive) setLoadError((e as { message?: string })?.message ?? '加载失败，请重试')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    // 导航标题按分类走（页面配置里写的是通用兜底）；失败（如自定义导航栏）静默忽略
    Taro.setNavigationBarTitle({ title: meta.pageTitle }).catch(() => undefined)
    return () => {
      alive = false
    }
  }, [meta.code, meta.pageTitle, reloadTick])

  /**
   * 切到某一节课。
   *
   * ★ 为什么要 setTimeout：`setCurrent` 之后小程序才把新 src 下发给原生播放器，
   *   同一 tick 里调 `play()` 操作的还是**上一个** src 的实例（表现是「点了没反应」）。
   *   120ms 是给下发留的最小余量；即使这次没赶上也不影响可用性 ——
   *   `autoplay` 已经为 true，用户还能自己按播放键。
   */
  const playItem = (item: TutorialItem) => {
    if (item.id === current?.id) return
    userPicked.current = true
    setCurrent(item)
    setTimeout(() => {
      try {
        videoCtx().play()
      } catch {
        /* 播放器还没就绪就算了 */
      }
    }, 120)
  }

  const onFullscreen = () => {
    try {
      // direction: 0 = 正常竖向。教学视频是竖屏 9:16 的，转横屏只会更小
      videoCtx().requestFullScreen({ direction: 0 })
    } catch {
      Taro.showToast({ title: '当前环境不支持全屏', icon: 'none' })
    }
  }

  return (
    <View className='tutorial'>
      {/* ── 深色舞台：播放器 + 全屏 ── */}
      <View className='tutorial__stage'>
        {/* 单独一层定位容器：全屏按钮要相对**播放器**垂直居中，不是相对整个舞台
            （舞台底部还有 48rpx 是留给白页签压上来的） */}
        <View className='tutorial__videobox'>
          {current?.videoUrl ? (
            <Video
              id={VIDEO_ID}
              className='tutorial__video'
              src={current.videoUrl}
              poster={current.coverUrl ?? undefined}
              controls
              showCenterPlayBtn
              autoplay={userPicked.current}
              onError={() => Taro.showToast({ title: '视频加载失败，请稍后重试', icon: 'none' })}
            />
          ) : (
            <View className='tutorial__placeholder'>
              <t-icon name='film' size='64rpx' color='rgba(255, 255, 255, 0.42)' />
              <Text className='tutorial__placeholder-text'>
                {loading ? '加载中…' : '这节课还没有上传视频'}
              </Text>
            </View>
          )}
          <View className='tutorial__fullscreen' hoverClass='ds-hover' onClick={onFullscreen}>
            <t-icon name='fullscreen' size='38rpx' color='#ffffff' />
            <Text className='tutorial__fullscreen-text'>全屏</Text>
          </View>
        </View>
      </View>

      {/* ── 白色列表页签 ── */}
      <View className='tutorial__panel'>
        <View className='tutorial__panelhead'>
          <Text className='tutorial__paneltitle'>{meta.pageTitle}</Text>
          {items.length > 0 && <Text className='tutorial__panelcount'>共 {items.length} 节</Text>}
        </View>

        {loading && <View className='tutorial__tip'>加载中…</View>}

        {!loading && !!loadError && (
          <View className='ds-empty'>
            <Text className='ds-empty__text'>{loadError}</Text>
            <View className='ds-empty__action' hoverClass='ds-hover' onClick={() => setReloadTick((t) => t + 1)}>
              重新加载
            </View>
          </View>
        )}

        {!loading && !loadError && items.length === 0 && (
          <View className='ds-empty'>
            <Text className='ds-empty__text'>这个分类还没有课程，稍后再来看看</Text>
          </View>
        )}

        {!loading &&
          !loadError &&
          items.map((item) => (
            <View
              key={item.id}
              className={`tutorial__row${item.id === current?.id ? ' is-active' : ''}`}
              hoverClass='ds-hover'
              onClick={() => playItem(item)}
            >
              <View className='tutorial__rowicon'>
                <t-icon
                  name={item.id === current?.id ? 'play-circle-filled' : 'play-circle'}
                  size='36rpx'
                  color={item.id === current?.id ? '#e1251b' : '#8e939a'}
                />
              </View>
              <Text className='tutorial__rowtitle'>{item.title}</Text>
            </View>
          ))}
      </View>
    </View>
  )
}
