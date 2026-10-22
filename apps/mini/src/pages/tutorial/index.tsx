import { useEffect, useState } from 'react'
import { View, Text, Image } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import {
  TUTORIAL_CATEGORIES,
  listTutorials,
  tutorialCategoryOf,
  type TutorialItem,
} from '../../services/tutorial'
import { useAppShare } from '../../utils/app-share'
import './index.scss'

/**
 * 参考视频 · 分类清单页（`/pages/tutorial/index?category=SHOOTING`）。
 *
 * ── 这一页**没有播放器**，改过一次，别再改回去 ───────────────────────────
 * 2026-10-22 之前这里是「顶部深色舞台放 `<Video>` + 下方点选切换」。腾讯审核按这一形态
 * 判了「涉及提供播放、观看等服务，请补充选择：文娱-其他视频类目」（该类目要 6 选 1 资质）。
 * 换组件没用 —— 它判的是**页面形态**；而换 `<channel-video>` 内嵌又走不通：
 * 视频号是个人未认证（＝没有主体），与企业主体小程序属跨主体，进不了关联主体列表。
 *
 * 现在这一页只是**外链目录**：列出标题，点一下用 `Taro.openChannelsActivity` 跳到视频号播放。
 * ⚠ 三样东西要一起守住，少一样就可能又被判类目：
 *   ① 页面里不出现 `<Video>` / `<channel-video>`（没有播放、观看能力）；
 *   ② 文案不出现「课程 / 教程 / 教学 / 学习 / 技巧 / 知识 / 手册」；
 *   ③ 计数用「条」不用「节」。
 */
export default function TutorialPage() {
  const router = useRouter()
  // 大小写不敏感：这个参数是各入口手拼出来的，不指望调用方一定大写
  const code = String(router.params.category ?? 'SHOOTING').toUpperCase()
  const meta = tutorialCategoryOf(code) ?? TUTORIAL_CATEGORIES[0]

  const [items, setItems] = useState<TutorialItem[]>([])
  /**
   * 分类名（导航标题 + 页内大标题）。
   * ★ 2026-10-22：名称由运营在后台改、跟着列表接口一起下发，本地常量只是兜底
   *   ⇒ 改名字不需要重新发版，也不需要重新提审。
   */
  const [title, setTitle] = useState(meta.pageTitle)

  // 分享：本页免登录可读，卡片可以直接指向对应分类
  // ★ 标题用 state（后台改过的名字），不是本地常量 —— 分享出去的名字也得跟着变
  useAppShare({
    title,
    path: `/pages/tutorial/index?category=${meta.code}`,
  })

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  /** 重试计数：改它就重跑下面的 effect（比在按钮里复制一遍请求干净） */
  const [reloadTick, setReloadTick] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadError('')
    listTutorials(meta.code)
      .then((r) => {
        if (!alive) return
        setItems(r.items)
        // 后台配了名字就用它；没配/空串 ⇒ 保持本地兜底（不要把标题改成空）
        if (r.title && r.title.trim()) setTitle(r.title.trim())
      })
      .catch((e) => {
        if (alive) setLoadError((e as { message?: string })?.message ?? '加载失败，请重试')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    // ⚠ 这里**不设**导航标题：标题可能在响应回来后变（后台改过名），交给下面那个 effect。
    //   如果在这里设、又把 title 加进依赖，就会「设标题 → 触发请求 → 再设标题」地循环。
    return () => {
      alive = false
    }
  }, [meta.code, reloadTick])

  // 导航标题跟着 name 走（页面配置里写的是通用兜底）；失败（如自定义导航栏）静默忽略
  useEffect(() => {
    Taro.setNavigationBarTitle({ title }).catch(() => undefined)
  }, [title])

  /**
   * 跳到视频号播放这一条。
   *
   * ★ 为什么不用「先 canIUse 再调」：`openChannelsActivity` 从基础库 2.19.2 起就有，
   *   本项目 minimum 版本远高于它；真正会失败的只有「参数不对 / 视频被作者删了」，
   *   那两种都只能走 fail 分支，预判没有意义。
   * ★ 失败必须给提示：这个接口失败时**什么都不发生**（不像 navigateTo 会打日志），
   *   不给 toast 的话用户只会觉得「点了没反应」。
   */
  const openInChannels = (item: TutorialItem) => {
    const finderUserName = item.finderUserName
    if (!finderUserName || !item.feedId) {
      Taro.showToast({ title: '这条还没配好，先看别的', icon: 'none' })
      return
    }
    // H5 / 低版本宿主上没有这个 API，直接调会 TypeError（不是 Promise rejection，catch 兜不住）
    if (typeof Taro.openChannelsActivity !== 'function') {
      Taro.showToast({ title: '请在微信小程序里观看', icon: 'none' })
      return
    }
    Taro.openChannelsActivity({ finderUserName, feedId: item.feedId }).catch(() => {
      Taro.showToast({ title: '打开视频号失败，请稍后再试', icon: 'none' })
    })
  }

  return (
    <View className='tutorial'>
      <View className='tutorial__panel'>
        <View className='tutorial__panelhead'>
          <Text className='tutorial__paneltitle'>{title}</Text>
          {items.length > 0 && <Text className='tutorial__panelcount'>共 {items.length} 条</Text>}
        </View>

        {/* 这句是**合规语义**的一半：明确告诉用户内容在视频号里，本页不提供播放 */}
        <Text className='tutorial__hint'>视频都在微信视频号里，点一下过去看</Text>

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
            <Text className='ds-empty__text'>这里还没有内容，稍后再来看看</Text>
          </View>
        )}

        {!loading &&
          !loadError &&
          items.map((item, i) => (
            <View
              key={item.id}
              className='tutorial__row'
              hoverClass='ds-hover'
              onClick={() => openInChannels(item)}
            >
              <Text className='tutorial__rowindex'>{i + 1}</Text>
              {/* 封面可有可无：有就显示缩略图（3:4 竖版），没有就整行纯文字 */}
              {!!item.coverUrl && (
                <Image className='tutorial__rowcover' src={item.coverUrl} mode='aspectFill' />
              )}
              <View className='tutorial__rowmain'>
                <Text className='tutorial__rowtitle'>{item.title}</Text>
                <Text className='tutorial__rowmeta'>
                  {item.durationMs ? `${Math.round(item.durationMs / 1000)} 秒` : '微信视频号'}
                </Text>
              </View>
              <View className='tutorial__rowgo'>
                <Text className='tutorial__rowgotext'>观看</Text>
                <t-icon name='chevron-right' size='28rpx' color='#8e939a' />
              </View>
            </View>
          ))}

        {!loading && !loadError && items.length > 0 && (
          <Text className='tutorial__foot'>以上内容来自我们的微信视频号，更新以视频号为准</Text>
        )}
      </View>
    </View>
  )
}
