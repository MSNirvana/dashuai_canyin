import { useEffect, useRef, useState } from 'react'
import { Button, Image, Input, View, Text } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import * as authApi from '../../services/auth'
import { pickAndUploadAvatar } from '../../services/profile'
import AgreeCheckbox from '../../components/agree-checkbox'
import { listMembershipReminders, markMembershipReminderRead, type MembershipReminder } from '../../services/account'
import { TUTORIAL_CATEGORIES, listTutorialStats } from '../../services/tutorial'
import { getContactInfo, type ContactInfo } from '../../services/contact'
import { type StoreItem } from '../../services/store'
import { STORAGE_KEYS } from '../../config'
import { platform } from '../../platform'
import { useMerchantStore } from '../../store/merchant'
import logoPng from '../../assets/logo.png'
// 会员到期日只到日（formatDay），与「订阅」页、个人资料页同一入口
import { formatDay } from '../../utils/time'
import './index.scss'

function humanBytes(b: string): string {
  const n = Number(b)
  const GB = 1024 * 1024 * 1024
  if (n >= GB) return `${(n / GB).toFixed(2)}GB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`
  if (n > 0) return `${Math.round(n / 1024)}KB`
  return '0B'
}

const PHONE_RE = /^1[3-9]\d{9}$/
const CODE_RE = /^\d{6}$/
/** 开发登录固定使用的演示账号。刻意**不**取短信输入框的值 —— 否则「开发登录」与
 *  「手机号登录」两个入口共用一个输入框，测短信时会静默登成演示账号。 */
const DEV_PHONE = '13800000000'

export default function Mine() {
  const merchant = useMerchantStore((s) => s.merchant)
  const isMember = useMerchantStore((s) => s.isMember)
  const memberPlanName = useMerchantStore((s) => s.memberPlanName)
  const memberEndAt = useMerchantStore((s) => s.memberEndAt)
  const storageUsed = useMerchantStore((s) => s.storageUsed)
  const storageQuota = useMerchantStore((s) => s.storageQuota)
  const storageSubscribed = useMerchantStore((s) => s.storageSubscribed)
  const refreshMe = useMerchantStore((s) => s.refreshMe)
  const refreshProfile = useMerchantStore((s) => s.refreshProfile)
  const setProfile = useMerchantStore((s) => s.setProfile)
  const avatarUrl = useMerchantStore((s) => s.avatarUrl)
  const token = useMerchantStore((s) => s.token)
  const loadStores = useMerchantStore((s) => s.loadStores)
  const setLogin = useMerchantStore((s) => s.setLogin)
  const logout = useMerchantStore((s) => s.logout)

  const [loading, setLoading] = useState(true)
  const [showLogin, setShowLogin] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [devMode, setDevMode] = useState(false)
  const [reminders, setReminders] = useState<MembershipReminder[]>([])
  /** 学习中心每个分类的课程数（code → 节数）。拿不到就是空对象，四宫格照常渲染 */
  const [tutorialCounts, setTutorialCounts] = useState<Record<string, number>>({})
  /**
   * 「联系我们」的二维码与客服电话（运营在后台配）。
   * ★ null = 不渲染整块（接口挂了 / 运营还没配 / 值不是合法 JSON 都归到这里）。
   */
  const [contact, setContact] = useState<ContactInfo | null>(null)
  /**
   * 「联系我们」那一行的展开态（默认收起）。
   * ★ 为什么要收起：它现在跟「学习中心」一样是**分组列表里的一行**，而不再是页尾一张常驻卡片。
   *   二维码（216rpx）+ 电话行加起来把页尾撑得很高，常驻会把「退出登录」推远；
   *   而真要点它的人（有搞不定的要找客服）点一下也就展开了。
   */
  const [contactOpen, setContactOpen] = useState(false)
  /** 一键拨打的再入闸门：连点会连开两次系统拨号确认框，用户只会以为是卡了 */
  const dialLock = useRef(false)
  const loginRequest = useRef(0)

  // ── 短信登录（备选通道）──
  // 存在理由：微信一键登录拿的是**本人**微信绑定的手机号，员工帮店主管理 / 代运营时
  // 无法登录他人账号，所以需要一个不依赖微信的入口。
  const [mode, setMode] = useState<'wechat' | 'sms'>('wechat')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const [smsSubmitting, setSmsSubmitting] = useState(false)
  /**
   * 是否已**主动勾选**同意《用户协议》和《隐私政策》。
   *
   * ★★ 默认 false、且每次打开弹窗都重置（见下面那个 `useEffect [showLogin]`）——
   *   这是「明示同意」与「默示同意」的分界线：勾过一次就永久记住，等于没让用户选。
   * ★ 未勾选时**所有会采集手机号的入口都要挡住**：微信一键登录（原生授权框）、
   *   「获取验证码」（会把手机号发给服务端）、「登录」。只在最后一关卡住是不够的。
   */
  const [agreed, setAgreed] = useState(false)

  // 再入闸门必须用**同步 ref**：React setState 是异步的，且 Taro 经 native setData 下发属性
  // （双异步），仅靠 state / disabled 挡不住连点。
  // 连点「获取验证码」的代价是实打实的：用户多收一条、我们多花一条钱、还会撞上 60s 冷却。
  const sendLock = useRef(false)
  const smsLoginLock = useRef(false)
  /** 换头像的门闩：上传要几百毫秒，连点会并发发两次，后到的覆盖先到的（用户看到的不是自己选的那张） */
  const avatarLock = useRef(false)
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  useDidShow(() => {
    const currentToken = Taro.getStorageSync<string>(STORAGE_KEYS.token) || ''
    if (!currentToken && useMerchantStore.getState().token) logout()
    // ★★ 2026-10-01（微信审核驳回整改）：**不再自动弹登录框**。
    //   原来未登录进入本页就直接弹 —— 而审核要求「用户体验浏览功能服务后，
    //   再自行选择授权登录」，自动弹等于替用户做了决定。
    //   改成页头显示「点击登录」（见下方 JSX），用户点了才弹。
    //   ★ 下面 `auth:required`（操作撞 401）那条自动弹**保留**：那是用户主动触发的。
    // ★ 「联系我们」是**公开配置**（免登录可读），与登录态无关 ⇒ 刻意放在下面那个
    //   `if (currentToken)` **外面**：登录不了恰恰是最需要客服的时候，关掉登录弹窗后
    //   这一块必须是好的。同样是「单独发、单独吞错」，不并进页面的 Promise.all。
    //   （getContactInfo 自身失败即返回 null，这里的 catch 只是兜住「它意外抛了」）
    void getContactInfo().then(setContact).catch(() => undefined)
    if (currentToken) {
      // 学习中心的课程数是**锦上添花**：单独发、单独吞错，绝不并进下面的 Promise.all
      // ——否则教学接口一慢，整页「加载中…」跟着一起等。
      void listTutorialStats()
        .then((r) => setTutorialCounts(Object.fromEntries(r.categories.map((c) => [c.code, c.count]))))
        .catch(() => undefined)
      Promise.all([
        refreshMe(),
        // 昵称与头像不在 /orders/me 里，必须单独拉一次；失败不能连累整页（头像空着也能用）
        refreshProfile().catch(() => undefined),
        listMembershipReminders().then(setReminders),
      ]).catch(() => undefined).finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  })

  useEffect(() => {
    if (!showLogin) return
    authApi.getDevMode().then((r) => setDevMode(r.enabled)).catch(() => setDevMode(false))
    // 每次**重新打开**弹窗都回到微信入口：留着上次输入的手机号/验证码只会让人困惑，
    // 而验证码 5 分钟就失效了。注意这个 effect 只在 showLogin false→true 时跑，
    // 从协议页返回时弹窗一直是 true，不会把用户正在输入的短信表单清掉。
    setMode('wechat')
    setCode('')
    // ★ 同意勾选**每次打开都回到未勾**：它是本次登录的明示同意，不是一次性设置。
    setAgreed(false)
  }, [showLogin])

  // 卸载时清掉冷却定时器：它每秒 setState，组件没了还在跑就是内存泄漏
  useEffect(() => {
    return () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current)
    }
  }, [])

  useEffect(() => {
    const requireLogin = () => {
      logout()
      setShowLogin(true)
    }
    Taro.eventCenter.on('auth:required', requireLogin)
    return () => {
      Taro.eventCenter.off('auth:required', requireLogin)
    }
  }, [logout])

  const onGetPhoneNumber = async (e: { detail: { code?: string } }) => {
    const phoneCode = e.detail?.code
    if (!phoneCode) {
      Taro.showToast({ title: '需要授权手机号才能登录', icon: 'none' })
      return
    }
    if (submitting) return
    const requestNo = ++loginRequest.current
    setSubmitting(true)
    try {
      const { code } = await platform.login()
      const res = await authApi.wechatLogin({ phoneCode, wxLoginCode: code })
      if (requestNo !== loginRequest.current) return
      setLogin(res)
      setShowLogin(false)
      await refreshMe().catch(() => undefined)
      Taro.showToast({ title: '登录成功', icon: 'success' })
    } catch (err) {
      Taro.showToast({ title: (err as { message?: string })?.message ?? '登录失败，请重试', icon: 'none', duration: 2500 })
    } finally {
      if (requestNo === loginRequest.current) setSubmitting(false)
    }
  }

  const onDevLogin = async () => {
    if (submitting) return
    setSubmitting(true)
    try {
      const res = await authApi.devLogin(DEV_PHONE)
      setLogin(res)
      setShowLogin(false)
      await refreshMe().catch(() => undefined)
      Taro.showToast({ title: '开发登录成功', icon: 'success' })
    } catch (err) {
      Taro.showToast({ title: (err as { message?: string })?.message ?? '开发登录失败', icon: 'none', duration: 2500 })
    } finally {
      setSubmitting(false)
    }
  }

  const toastErr = (err: unknown, fallback: string) => {
    Taro.showToast({ title: (err as { message?: string })?.message ?? fallback, icon: 'none', duration: 2500 })
  }

  /**
   * 未勾选同意时的统一拦截。
   *
   * ★ 为什么用 toast 而不是把按钮置灰：灰按钮说不出「为什么不能点」，用户只会以为坏了；
   *   这句话正好告诉他该去勾哪里。
   * ★★ 「手机号快捷登录」那一颗没法只做样式禁用 —— 它是 `open-type='getPhoneNumber'`，
   *   一旦被触发就会弹微信的手机号授权框，那已经是"收集"了。所以未勾选时**整颗换成
   *   普通 `<Button>`**（见下面的 JSX），点它只会弹这句提示，原生授权框根本不会出现。
   */
  const needAgree = () => {
    Taro.showToast({ title: '请先阅读并勾选同意《用户协议》和《隐私政策》', icon: 'none', duration: 2500 })
  }

  const startCooldown = (sec: number) => {
    if (cooldownTimer.current) clearInterval(cooldownTimer.current)
    setCooldown(sec)
    cooldownTimer.current = setInterval(() => {
      setCooldown((c) => {
        if (c <= 1) {
          if (cooldownTimer.current) clearInterval(cooldownTimer.current)
          cooldownTimer.current = null
          return 0
        }
        return c - 1
      })
    }, 1000)
  }

  /** 获取短信验证码。冷却时长以后端返回的 cooldownSec 为准，不在前端写死。 */
  const onSendCode = async () => {
    if (cooldown > 0) return
    // ★ 未勾选同意就不发：这一步会把**手机号**发给服务端，属于「收集」，必须发生在取得同意之后
    if (!agreed) return needAgree()
    if (!PHONE_RE.test(phone)) {
      Taro.showToast({ title: '请输入正确的手机号', icon: 'none' })
      return
    }
    if (sendLock.current) return
    sendLock.current = true
    try {
      const r = await authApi.sendSmsCode(phone)
      const sec = typeof r?.cooldownSec === 'number' && r.cooldownSec > 0 ? r.cooldownSec : 60
      startCooldown(sec)
      if (r?.demoLogin) {
        // ★ 服务端**没有**发短信：这是演示账号，后台给它配了固定登录验证码。
        //   照旧弹「验证码已发送」会让人盯着一台不会响的手机等短信，
        //   而正确的做法（直接把那枚码敲进去）就在眼前。这里必须说真话。
        Taro.showToast({ title: '演示账号无需验证码，直接输码登录', icon: 'none', duration: 3000 })
      } else {
        Taro.showToast({ title: '验证码已发送', icon: 'success' })
      }
    } catch (err) {
      toastErr(err, '发送失败，请稍后重试')
    } finally {
      sendLock.current = false
    }
  }

  /** 手机号 + 验证码登录（登录他人账号的唯一通道） */
  const onSmsLogin = async () => {
    // ★ 手机号登录同理：提交给服务端前必须先取得同意
    if (!agreed) return needAgree()
    if (!PHONE_RE.test(phone)) {
      Taro.showToast({ title: '请输入正确的手机号', icon: 'none' })
      return
    }
    if (!CODE_RE.test(code)) {
      Taro.showToast({ title: '请输入 6 位验证码', icon: 'none' })
      return
    }
    if (smsLoginLock.current) return
    smsLoginLock.current = true
    setSmsSubmitting(true)
    try {
      const res = await authApi.loginByPhone(phone, code)
      setLogin(res)
      setShowLogin(false)
      await refreshMe().catch(() => undefined)
      Taro.showToast({ title: '登录成功', icon: 'success' })
    } catch (err) {
      toastErr(err, '登录失败，请重试')
    } finally {
      smsLoginLock.current = false
      setSmsSubmitting(false)
    }
  }

  // 带上 fail：跳转失败时把目标 url 打进日志。
  // 否则失败会以「navigateTo:fail timeout」的形式被抛到 App.onError，
  // 控制台里只有一堆 WAServiceMainContext 的栈，看不到是哪个页面挂了。
  //
  // ★ 末尾那个 .catch 不是多余的：Taro 的 navigateTo 除了回调，**还会返回一个 Promise**，
  //   只给 fail 回调而不接住这个 Promise，失败时会以「未处理的 Promise 拒绝」冒到
  //   App.onError，控制台里就变成一行 `MiniProgramError {"errMsg":"navigateTo:fail timeout"}`
  //   —— 正是上面想避免的那种「看不出是哪个页面挂了」。
  //   日志已经由 fail 打过，所以这里静默接住即可（navigateTo 的返回类型就是 Promise）。
  const go = (url: string) =>
    Taro.navigateTo({ url, fail: (e) => console.warn('[nav] 跳转失败', url, e?.errMsg) }).catch(
      () => undefined,
    )

  /**
   * 进「门店资料」。
   * ★ 单店模型（2026-09-24）：门店不再是「列表页 → 进入」，这个入口直接进账号**唯一门店**的
   *   详情（门店信息）；还没有门店才去创建页（原「门店列表」页已删除）。
   * ★ 这里现拉一次门店列表，而不是直接读全局 currentStoreId：冷启动 / 刚登录时它可能还是空的，
   *   拿它判断会把**有门店**的用户误判成「没有门店」，送去创建页 —— 而创建会被服务端拒绝
   *   （一个账号只能一家门店），用户拿到的只是一句看不懂的报错。
   */
  const goStore = async () => {
    const list = await loadStores().catch(() => [] as StoreItem[])
    const id = list.find((s) => s.isDefault)?.id ?? list[0]?.id ?? useMerchantStore.getState().currentStoreId
    go(id ? `/pages/store/detail?id=${id}` : '/pages/store/edit')
  }

  /**
   * 点头像直接换头像（不跳页）。
   *
   * 与个人主页共用 `pickAndUploadAvatar()`：选图 + multipart 上传 + 服务端写 merchant.avatar_key。
   * 一并在本页做，是因为用户对这个入口的预期是「点头像就能换」，多一跳反而多一次犹豫。
   * 服务端返回的是**最新完整资料**，所以顺手把昵称也同步了（避免两处显示不一致）。
   */
  const onChangeAvatar = async () => {
    // 未登录时弹窗可以被 × 关掉，页面上仍留着这个头像位；没有 token 就先别发起上传
    if (!token) return
    if (avatarLock.current) return
    avatarLock.current = true
    try {
      const p = await pickAndUploadAvatar()
      // null = 用户在选图器里点了取消，不是失败：静默返回，不弹错误
      if (!p) return
      setProfile({ nickname: p.nickname, avatarUrl: p.avatarUrl })
      Taro.showToast({ title: '头像已更新', icon: 'success' })
    } catch (err) {
      toastErr(err, '头像上传失败')
    } finally {
      avatarLock.current = false
    }
  }

  /**
   * 一键拨打客服电话（「联系我们」那一行）。
   *
   * ★ 号码用 `contact.dial`（已清洗），**不是**展示用的 `contact.phone` ——
   *   运营很可能填 `400-123-4567` 这种给人看的写法，带分隔符的号码在部分机型上会被
   *   `tel:` 协议截断，而这类问题**只在真机上现形**（见 services/contact.ts::toDialable）。
   *
   * ★ 失败要**分辨着**处理：用户在系统拨号确认框上点「取消」时，微信回的是
   *   `makePhoneCall:cancel`（走 reject）—— 那是用户的正常选择，不是故障。
   *   对它弹错了信息，用户会以为号码有问题。只有真正拨不出去才提示。
   *
   * ★ 末尾那个 .catch 与上面 `go` 同理：Taro 的 API 除了回调**还会返回 Promise**，
   *   不接住失败会以「未处理的 Promise 拒绝」冒到 App.onError。
   */
  const dialPhone = () => {
    if (!contact?.dial || dialLock.current) return
    dialLock.current = true
    Taro.makePhoneCall({ phoneNumber: contact.dial })
      .catch((e: unknown) => {
        const errMsg = String((e as { errMsg?: string })?.errMsg ?? '')
        if (errMsg.includes('cancel')) return
        Taro.showToast({ title: `拨号失败，请手动拨打 ${contact.phone}`, icon: 'none', duration: 2500 })
      })
      .finally(() => { dialLock.current = false })
  }

  /**
   * 点二维码放大预览（长按识别那条路走的是 Image 的 `showMenuByLongpress`，见下面的 JSX）。
   * 预览页里微信同样提供「识别图中二维码」，所以点按与长按都能到同一个结果，
   * 只是点按多给了一次「看清这张码」的机会。
   *
   * ★ 单张图也要走 previewImage 的 `current` + `urls[0]` 同为这张：
   *   `current` 靠「能在 urls 里精确匹配到」定位，匹配不上会静默回落到第一张
   *   （见 pages/dish/detail.tsx 的说明）。只有一张时天然满足。
   */
  const previewQrcode = () => {
    if (!contact?.qrcode) return
    Taro.previewImage({ current: contact.qrcode, urls: [contact.qrcode] })
  }

  /**
   * 退出登录。
   *
   * 只清**本地**会话（store.logout() → clearSession() 清 token/refreshToken/商户信息 +
   * store 重置）。服务端的 refreshToken 是**无状态 JWT**（30 天有效期），
   * 目前没有吊销接口，所以退出后旧 refreshToken 在有效期内仍可换新 token ——
   * 见「服务端无 /auth/logout」的遗留说明，不要以为这里已经把它作废了。
   *
   * 三处必须一起清，否则会出现「换账号登录后看到上一个人的数据」：
   *   · store.logout()      商户信息 / 积分 / 会员 / 门店
   *   · setReminders([])    会员到期提醒（本页状态，来自上一个账号）
   *   · setPhone('')        短信登录输入框里残留的上一个手机号
   */
  const onLogout = () => {
    // 二次确认：退出不可逆（要重新走微信授权或短信验证码），误触代价明显
    Taro.showModal({
      title: '退出登录',
      content: '退出后需重新登录',
      confirmText: '退出',
      confirmColor: '#c21b12',
      success: (r) => {
        if (!r.confirm) return
        logout()
        setReminders([])
        setPhone('')
        setCode('')
        // 本页的「未登录态」就是登录弹窗（与 useDidShow 里 setShowLogin(!token) 保持一致），
        // 必须显式置 true：退出时页面不会重新 onShow，否则会停在一个不刷新的空壳页上。
        setShowLogin(true)
        Taro.showToast({ title: '已退出登录', icon: 'none' })
      },
    })
  }
  const quotaNum = Number(storageQuota)
  const usedNum = Number(storageUsed)
  const pct = quotaNum > 0 ? Math.min(100, Math.round((usedNum / quotaNum) * 100)) : 0

  return (
    <View className='mine'>
      {/* ── 头像区 ── */}
      <View className='mine__head'>
        <View className='mine__head-deco' />
        {/* 点头像 = 直接换头像（不跳页）；点用户名 = 进个人主页改昵称等 */}
        <View className='mine__avatarbox' onClick={onChangeAvatar} hoverClass='ds-hover'>
          <View className='mine__avatar'>
            {avatarUrl ? (
              <Image className='mine__avatar-img' src={avatarUrl} mode='aspectFill' />
            ) : (
              <Text>{merchant?.nickname?.[0] ?? (merchant?.phone?.[0] ?? '客')}</Text>
            )}
          </View>
          {/* 角标放在裁剪容器外：圆形 overflow:hidden 会把圆外的角标裁掉 */}
          <View className='mine__avatar-badge'>
            <t-icon name='camera' size='22rpx' color='#ffffff' />
          </View>
        </View>
        <View className='mine__info'>
          {/* ★★ 2026-10-01：未登录时这里就是**登录入口**（不再一进页面就自动弹框，见 useDidShow）。
              原来那行固定显示「未登录」，点了还会跳个人主页（未登录必吃 401）；现在未登录时
              它变成可点的「点击登录」，由用户自己决定什么时候授权。 */}
          {token ? (
            <Text className='mine__name' onClick={() => go('/pages/profile/index')}>
              {merchant?.nickname || merchant?.phone || '未登录'}
            </Text>
          ) : (
            <Text className='mine__name mine__name--login' onClick={() => setShowLogin(true)}>
              点击登录
            </Text>
          )}
          {isMember ? (
            <View className='mine__vipwrap'>
              <Text className='ds-pill ds-pill--gold mine__vip--on'>
                <t-icon name='user-vip' size='24rpx' color='#a8741f' /> {memberPlanName}
              </Text>
              <Text className='mine__vipend'>至 {formatDay(memberEndAt)}</Text>
            </View>
          ) : (
            <View className='mine__vipwrap' onClick={() => go('/pages/recharge/index')}>
              <Text className='ds-pill ds-pill--red-outline'>未订阅</Text>
              <Text className='mine__vipend mine__vipend--cta'>去开通 ›</Text>
            </View>
          )}
        </View>
      </View>

      {/* 积分卡（余额概览 + 充值入口）已整体搬到「个人主页」；本页保留下方菜单里的「订阅与积分」入口 */}
      {reminders.map((item) => (
        <View key={item.id} className='mine__tip' onClick={() => {
          void markMembershipReminderRead(item.id)
          setReminders((items) => items.filter((v) => v.id !== item.id))
        }}>
          会员将在 {item.reminderDays} 天后到期，点击前往续费 ›
        </View>
      ))}
      {/* ── 空间 ── */}
      <View className='mine__storage'>
        <View className='mine__storagehead'>
          <Text className='mine__storagetitle'>
            <t-icon name='cloud' size='14px' color='#646a73' /> 上传空间{storageSubscribed ? ' · 订阅 5GB' : ' · 普通 1GB'}
          </Text>
          <Text className='mine__storageval'>{humanBytes(storageUsed)} / {humanBytes(storageQuota)}</Text>
        </View>
        <View className='mine__storagebar'>
          <View
            className='mine__storagefill'
            style={{ width: `${pct}%`, background: pct >= 90 ? '#c4892c' : undefined }}
          />
        </View>
      </View>

      {/* ── 我的资料：卡片 + 横排三入口 ──
          ★ 2026-09-24：与「学习中心」整块互换 —— 这一块改用原来的「入口宫格」样式
            （图标在上、文字在下、横排），所以三个入口不再竖着排成列表。
          图标沿用列表里那枚彩色圆角底：门店=红 / 菜品=绿 / 订阅=金，颜色语义保持不变。 */}
      <View className='mine__learn'>
        <Text className='mine__learn-title'>我的资料</Text>
        <View className='mine__learn-grid'>
          <View className='mine__learn-item' hoverClass='ds-hover' onClick={() => { void goStore() }}>
            <View className='mine__item-icon mine__item-icon--red'><t-icon name='shop' size='34rpx' /></View>
            <Text className='mine__learn-label'>门店资料</Text>
          </View>
          <View className='mine__learn-item' hoverClass='ds-hover' onClick={() => go('/pages/dish/list')}>
            <View className='mine__item-icon mine__item-icon--green'><t-icon name='rice' size='34rpx' /></View>
            <Text className='mine__learn-label'>菜品管理</Text>
          </View>
          <View className='mine__learn-item' hoverClass='ds-hover' onClick={() => go('/pages/recharge/index')}>
            <View className='mine__item-icon mine__item-icon--gold'><t-icon name='wallet' size='34rpx' /></View>
            <Text className='mine__learn-label'>订阅与积分</Text>
          </View>
        </View>
      </View>

      {/* ── 学习中心：分组列表（原「我的资料」的 iOS 列表样式）──
          图标与文案来自 services/tutorial.ts 的本地常量：教学接口挂了这一块也要照常显示；
          节数拿不到时只是少一个小字，不影响进入。 */}
      {/* 交易分组：我的订单。
          这一行不只是「给用户看流水」—— 微信 2022-12-31 公告要求有「选购 → 下单 → 支付」
          闭环的小程序必须设置订单中心页（path = pages/order/list）；同时隐私政策里写着
          「你可以在『我的』页面查看账号信息、门店资料、积分与订单信息」，
          在这行之前那句话是空的：全站一个订单入口都没有。 */}
      <View className='ds-label'>交易</View>
      <View className='mine__menu'>
        <View className='mine__item' hoverClass='ds-hover' onClick={() => go('/pages/order/list')}>
          <View className='mine__item-icon'><t-icon name='order-list' size='32rpx' /></View>
          <View className='mine__item-copy'><Text className='mine__item-title'>我的订单</Text></View>
          <Text className='mine__arrow'>›</Text>
        </View>
      </View>

      <View className='ds-label'>学习中心</View>
      <View className='mine__menu'>
        {TUTORIAL_CATEGORIES.map((c) => (
          <View
            key={c.code}
            className='mine__item'
            hoverClass='ds-hover'
            onClick={() => go(`/pages/tutorial/index?category=${c.code}`)}
          >
            <View className='mine__item-icon'><t-icon name={c.icon} size='32rpx' /></View>
            <View className='mine__item-copy'><Text className='mine__item-title'>{c.label}</Text></View>
            {tutorialCounts[c.code] > 0 && (
              <Text className='mine__learn-count'>{tutorialCounts[c.code]} 节</Text>
            )}
            <Text className='mine__arrow'>›</Text>
          </View>
        ))}
      </View>
      {/* ── 更多服务：分组列表里的「联系我们」一行（点一下原地展开）──
          ★ 2026-09-29 改版（需求原话：「联系我们文字改成其他，然后在下面放一行选项，
            跟上面学习中心一样，文字是联系我们，然后把现在这个联系我们这个模块放进去，不要放外面」）
            ⇒ 分组小标题改名「更多服务」，模块从「页尾独立卡片」降为「列表行内的展开区」。
          ── 为什么收进列表里 ──
            二维码 + 电话常驻时，页尾是三张卡竖着叠（学习中心卡 / 联系我们卡 / 退出登录），
            而它跟学习中心本就是同一类东西：**点一下才知道里面有什么**。收进去后页尾只剩两张卡。
          ── 行骨架复用 .mine__item / .mine__menu，不新写一套 ──
            这两块上下相邻，样式一漂就立刻显得散。展开区（.mine__contact）挂在**同一张
            __menu 卡片内部** ⇒ 它自己不再带 margin / 描边 / 圆角 / 底色（见 index.scss）。
          ── 二维码：长按识别 ──
            `showMenuByLongpress` 是**微信原生**能力：长按图片弹出系统菜单，里面有
            「识别图中二维码」（以及保存图片）。这是小程序里唯一能做到「长按扫码」的路子 ——
            小程序**没有**「扫自己屏幕上这张码」的 API，而自绘长按手势只能弹自己的菜单，
            识别二维码那一步微信不会代劳。
          ── 电话：一键拨打 ──
            整行都是可点区（不只那颗「拨打」）。号码用 contact.dial（已清洗），
            不是展示用的 contact.phone，见 dialPhone 的注释。
          ── 三种「没东西可显示」都不渲染 ──
            contact === null ⇒ 连「更多服务」这个分组小标题都不出现；
            只配了电话 ⇒ 展开后只有电话那一行；只配了二维码 ⇒ 只有二维码那一行。
            ★ 判据是 contact.qrcode / contact.phone 两个字段本身，**不是** contact 是否非空。 */}
      {!!contact && (
        <>
          <View className='ds-label'>更多服务</View>
          <View className='mine__menu'>
            <View
              className='mine__item'
              hoverClass='ds-hover'
              onClick={() => setContactOpen((v) => !v)}
            >
              <View className='mine__item-icon'><t-icon name='service' size='32rpx' /></View>
              <View className='mine__item-copy'><Text className='mine__item-title'>联系我们</Text></View>
              {/* 收起是 ›、展开是 ⌄（同一个字形转 90°）。★ 用 transform 而不是换字形，否则会跳一下 */}
              <Text className={`mine__arrow${contactOpen ? ' mine__arrow--open' : ''}`}>›</Text>
            </View>
            {contactOpen && (
              <View className='mine__contact'>
                {!!contact.qrcode && (
                  <View className='mine__contact-row' hoverClass='ds-hover' onClick={previewQrcode}>
                    <Image
                      className='mine__qr'
                      src={contact.qrcode}
                      mode='aspectFit'
                      showMenuByLongpress
                    />
                    <View className='mine__contact-copy'>
                      <Text className='mine__contact-title'>在线客服</Text>
                      <Text className='mine__contact-hint'>识别二维码，添加客服</Text>
                    </View>
                  </View>
                )}
                {!!contact.phone && (
                  <View className='mine__contact-row' hoverClass='ds-hover' onClick={dialPhone}>
                    <View className='mine__item-icon mine__item-icon--red'>
                      <t-icon name='call' size='32rpx' />
                    </View>
                    <View className='mine__contact-copy'>
                      <Text className='mine__contact-title'>电话咨询</Text>
                      <Text className='mine__contact-num'>{contact.phone}</Text>
                    </View>
                    <Text className='mine__contact-dial'>拨打</Text>
                  </View>
                )}
              </View>
            )}
          </View>
        </>
      )}

      {/* ── 退出登录 ── 只在已登录时显示（未登录态本页被登录弹窗覆盖） */}
      {token && <View className='mine__logout' onClick={onLogout}>退出登录</View>}

      {loading && <View className='mine__tip'>加载中…</View>}

      {showLogin && !token && <View className='mine__login-mask' catchMove>
        <View className='mine__login-modal'>
          <View className='mine__login-close' onClick={() => setShowLogin(false)}>×</View>
          <Image className='mine__login-logo' src={logoPng} mode='aspectFit' />
          <Text className='mine__login-title'>登录大帅餐饮</Text>

          {mode === 'sms' ? (
            <>
              <View className='mine__login-field'>
                <Input
                  className='mine__login-input'
                  type='number'
                  maxlength={11}
                  value={phone}
                  placeholder='请输入手机号'
                  onInput={(e) => setPhone(e.detail.value)}
                />
              </View>
              <View className='mine__login-field'>
                <Input
                  className='mine__login-input'
                  type='number'
                  maxlength={6}
                  value={code}
                  placeholder='请输入 6 位验证码'
                  onInput={(e) => setCode(e.detail.value)}
                />
                <Text
                  className={`mine__login-code${cooldown > 0 ? ' is-disabled' : ''}`}
                  onClick={onSendCode}
                >
                  {cooldown > 0 ? `${cooldown}s 后重发` : '获取验证码'}
                </Text>
              </View>
              <Button className='mine__login-primary' onClick={onSmsLogin} disabled={smsSubmitting}>
                {smsSubmitting ? '登录中…' : '登录'}
              </Button>
              <View className='mine__login-switch' onClick={() => setMode('wechat')}>
                {devMode ? '返回本地开发登录' : '返回手机号快捷登录'}
              </View>
            </>
          ) : (
            <>
              {devMode ? (
                <Button className='mine__login-primary' onClick={onDevLogin} disabled={submitting}>
                  {submitting ? '登录中…' : '进入本地开发环境'}
                </Button>
              ) : agreed ? (
                <Button className='mine__login-primary' openType='getPhoneNumber' onGetPhoneNumber={onGetPhoneNumber} disabled={submitting}>
                  {submitting ? '登录中…' : '手机号快捷登录'}
                </Button>
              ) : (
                /* ★★ 未勾选同意时**换成普通按钮**：open-type 一旦触发就会弹微信的手机号授权框，
                   而那已经是"收集"了。换掉之后原生授权框根本不会出现，点它只弹提示。 */
                <Button className='mine__login-primary' onClick={needAgree}>
                  手机号快捷登录
                </Button>
              )}
              {/* 代运营 / 帮店主管理时，手机号快捷登录只能拿到本人手机号 ⇒ 必须留这条短信通道 */}
              <View className='mine__login-switch' onClick={() => setMode('sms')}>
                使用其他手机号登录
              </View>
            </>
          )}

          {/* ★★ 同意勾选放在弹窗**最底部**（按用户要求）。
              位置下移只影响阅读顺序；**合规三件套一个没少**：
              ① 独立可勾选框（不是「点击即视为同意」的说明文字）
              ② 默认不勾、每次开弹窗重置
              ③ 未勾选时三个入口全部拦住（快捷登录换普通按钮、获取验证码、登录）
              ⇒ 仍是**明示同意**，不是默示同意。两个登录模式共用这一个勾选状态。 */}
          <AgreeCheckbox checked={agreed} onChange={setAgreed} />
        </View>
      </View>}
    </View>
  )
}
