// 个人主页：换头像 + 改用户名（手机号只读，是账号身份，不作为可改项）
//
// 与「我的」页的分工：
//   · 头像**点一下就换**（不跳页）——「我的」页与这里都是这个行为，共用同一个 helper；
//   · 用户名等其它信息在这里改。
// 所以本页不做「保存后才上传头像」：头像选中即上传（服务端立刻写库），保存按钮只管昵称。
// 这样两个入口的行为一致，也不会出现「以为换好了其实没保存」。
import { useEffect, useRef, useState } from 'react'
import { Image, Input, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import * as profileApi from '../../services/profile'
import { useMerchantStore } from '../../store/merchant'
// 会员 / 赠积分到期日只到日（formatDay），不带时分；与「我的」页、订阅页同一入口
import { formatDay } from '../../utils/time'
import './index.scss'

/** 与服务端 `nullableText(20)` 对齐；Input 的 maxlength 也用它，三处不能各写一个数 */
const NICKNAME_MAX = 20

function errText(e: unknown, fallback: string): string {
  return (e as { message?: string })?.message || fallback
}

export default function Profile() {
  const merchant = useMerchantStore((s) => s.merchant)
  const avatarUrl = useMerchantStore((s) => s.avatarUrl)
  const setProfile = useMerchantStore((s) => s.setProfile)
  // 积分卡（自「我的」页整体搬来）：余额与赠积分到期日都在 store 里，由 refreshMe() 填充
  const available = useMerchantStore((s) => s.available)
  const rechargeBalance = useMerchantStore((s) => s.rechargeBalance)
  const grantBalance = useMerchantStore((s) => s.grantBalance)
  const frozen = useMerchantStore((s) => s.frozen)
  const memberEndAt = useMerchantStore((s) => s.memberEndAt)
  const refreshMe = useMerchantStore((s) => s.refreshMe)

  const [nickname, setNickname] = useState('')
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  // 上传期间的门闩必须用**同步 ref**：setUploading 是异步的，连点两下会同时发两个上传，
  // 结果后到的那个覆盖先到的，用户看到的头像和自己选的那张对不上
  const avatarLock = useRef(false)
  /** 保存的门闩同理：`saving` 是 state，连点两下挡不住（两个 PATCH 都发出去） */
  const saveLock = useRef(false)

  // 积分卡的余额 / 到期日**不在** /user/profile 里，得单独问一次 /orders/me。
  // 用 useDidShow 而不是 useEffect：从充值页买完返回时余额已经变了，只在挂载时拉一次会一直显示旧数字。
  // 它首次显示也会触发，所以初始加载一并覆盖。失败只静默 —— 昵称与头像照常显示，
  // 不能因为余额拉不到就让整页报错。
  useDidShow(() => {
    refreshMe().catch(() => undefined)
  })

  useEffect(() => {
    // setProfile 来自 zustand，引用稳定，不会让本 effect 反复跑
    profileApi
      .getProfile()
      .then((p) => {
        setNickname(p.nickname ?? '')
        setPhone(p.phone)
        // 顺手刷新 store：直接进本页（非从「我的」页跳来）时 store 里可能还是空的
        setProfile({ nickname: p.nickname, avatarUrl: p.avatarUrl })
      })
      .catch((e: unknown) => {
        Taro.showToast({ title: errText(e, '资料加载失败'), icon: 'none', duration: 2500 })
      })
      .finally(() => setLoading(false))
  }, [setProfile])

  const onChangeAvatar = async () => {
    if (avatarLock.current) return
    avatarLock.current = true
    setUploading(true)
    try {
      const p = await profileApi.pickAndUploadAvatar()
      // 用户取消选图不是失败，直接静默返回（否则每次点开选择器再退出都弹一次错误）
      if (!p) return
      setProfile({ nickname: p.nickname, avatarUrl: p.avatarUrl })
      Taro.showToast({ title: '头像已更新', icon: 'success' })
    } catch (e) {
      Taro.showToast({ title: errText(e, '头像上传失败'), icon: 'none', duration: 2500 })
    } finally {
      avatarLock.current = false
      setUploading(false)
    }
  }

  const onSave = async () => {
    if (saveLock.current) return
    // ★ 资料还没加载回来时绝不能放行：此时 nickname 是初始空串，保存会把库里的
    //   真实昵称清成 null（空值 = 清空，见下面注释）。样式上的 is-disabled 只是
    //   半透，不挡点击，必须在这里硬拦。
    if (loading) {
      Taro.showToast({ title: '资料还在加载，请稍候', icon: 'none' })
      return
    }
    saveLock.current = true
    const value = nickname.trim()
    setSaving(true)
    try {
      // 空值传 null（= 清空，展示时回落到手机号），不要传空串：库里会出现「有值却是空白」的行
      const p = await profileApi.updateProfile({ nickname: value === '' ? null : value })
      setNickname(p.nickname ?? '')
      setProfile({ nickname: p.nickname, avatarUrl: p.avatarUrl })
      Taro.showToast({ title: '已保存', icon: 'success' })
      // 让用户看清提示再退回上一页；直接 navigateBack 会有「闪一下不知道成没成」的感觉
      setTimeout(() => {
        Taro.navigateBack({ delta: 1 }).catch(() => Taro.switchTab({ url: '/pages/mine/index' }))
      }, 600)
    } catch (e) {
      Taro.showToast({ title: errText(e, '保存失败，请重试'), icon: 'none', duration: 2500 })
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }

  const letter = (nickname || merchant?.nickname || phone || '客').slice(0, 1)

  return (
    <View className='profile'>
      {/* ── 头像：点一下直接换（与「我的」页同一行为） ── */}
      <View className='profile__avatarwrap'>
        {/* 相机角标必须放在**裁剪容器之外**：圆形容器 overflow:hidden 会把落在圆外的角标裁掉 */}
        <View className='profile__avatarbox' onClick={onChangeAvatar} hoverClass='ds-hover'>
          <View className='profile__avatar'>
            {avatarUrl ? (
              <Image className='profile__avatar-img' src={avatarUrl} mode='aspectFill' />
            ) : (
              <Text className='profile__avatar-text'>{letter}</Text>
            )}
          </View>
          <View className='profile__avatar-badge'>
            <t-icon name='camera' size='26rpx' color='#ffffff' />
          </View>
        </View>
        {/* 只留「上传中…」这个状态；「点击更换/上传头像」是解释性小字，已删 */}
        {uploading && <Text className='profile__avatar-tip'>上传中…</Text>}
      </View>

      {/* ── 表单 ── */}
      <View className='ds-label'>基本信息</View>
      <View className='profile__form'>
        <View className='profile__row'>
          <Text className='profile__key'>用户名</Text>
          <Input
            className='profile__input'
            value={nickname}
            maxlength={NICKNAME_MAX}
            placeholder={`未设置时显示手机号（最多 ${NICKNAME_MAX} 个字）`}
            onInput={(e) => setNickname(e.detail.value)}
          />
        </View>
        <View className='profile__row'>
          <Text className='profile__key'>手机号</Text>
          <Text className='profile__readonly'>{phone || '—'}</Text>
        </View>
      </View>
      {/* 原「手机号是账号身份，不支持在这里修改。」已删（解释性小字） */}

      {/* ── 积分卡（自「我的」页整体搬来：余额概览 + 充值与续费入口） ── */}
      <View className='ds-label'>我的积分</View>
      <View className='profile__bean'>
        <View className='profile__beantop'>
          <View className='profile__beancell'>
            <Text className='profile__beannum'>{available}</Text>
            <Text className='profile__beanlabel'>可用积分</Text>
          </View>
          <View className='profile__beandiv' />
          <View className='profile__beancell'>
            <Text className='profile__beannum profile__beannum--gold'>{grantBalance}</Text>
            <Text className='profile__beanlabel'>赠积分</Text>
          </View>
          <View className='profile__beandiv' />
          <View className='profile__beancell'>
            <Text className='profile__beannum'>{frozen}</Text>
            <Text className='profile__beanlabel'>冻结中</Text>
          </View>
        </View>
        {/* 本页不是 tab 页，「订阅与积分」也不在 tabBar 里，所以走 navigateTo 而不是 switchTab */}
        <View
          className='ds-btn ds-btn--soft ds-btn--block profile__beanbtn'
          hoverClass='ds-hover'
          onClick={() => Taro.navigateTo({ url: '/pages/recharge/index' })}
        >
          订阅 / 加油包
        </View>
      </View>
      {/* 数字与文案必须写在同一行：View 的多个子文本节点之间会插入空白，断行会多出一个空格 */}
      <View className='profile__tip'>购买积分 {rechargeBalance}{memberEndAt ? ' · 赠积分到期 ' + formatDay(memberEndAt) : ''}</View>

      {/* 用 View + ds-btn 而不是 taro Button：省掉 Button 的默认边框/背景覆盖（项目里其它页同样写法） */}
      <View
        className={`ds-btn ds-btn--primary ds-btn--block profile__save${saving || loading ? ' is-disabled' : ''}`}
        hoverClass='ds-hover'
        onClick={onSave}
      >
        {saving ? '保存中…' : '保存'}
      </View>
    </View>
  )
}
