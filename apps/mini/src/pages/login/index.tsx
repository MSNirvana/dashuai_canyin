import { useEffect, useRef, useState } from 'react'
import { Button, Image, Text, View } from '@tarojs/components'
import Taro, { useRouter } from '@tarojs/taro'
import * as authApi from '../../services/auth'
import { useMerchantStore } from '../../store/merchant'
import logoPng from '../../assets/logo.png'
import './index.scss'

export default function LoginPage() {
  const router = useRouter()
  const setLogin = useMerchantStore((s) => s.setLogin)
  const token = useMerchantStore((s) => s.token)

  const [submitting, setSubmitting] = useState(false)
  const [devMode, setDevMode] = useState(false)
  const [phone] = useState('') // 仅 dev 登录使用（演示账号兜底，不展示输入）
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  // 已登录直接进首页（home 是 tabBar 页，用 switchTab）
  useEffect(() => {
    if (token) {
      Taro.switchTab({ url: '/pages/home/index' })
    }
  }, [token])

  // 进入时探测是否开启开发登录旁路
  useEffect(() => {
    authApi.getDevMode().then((r) => setDevMode(r.enabled)).catch(() => setDevMode(false))
  }, [])

  useEffect(() => {
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [])

  const goHome = () => {
    const back = (router.params.redirect as string) || ''
    if (back) {
      // redirect 目标可能是 tab 页也可能是普通页，reLaunch 两者都兼容（tab 页不支持 query）
      Taro.reLaunch({ url: decodeURIComponent(back) })
    } else {
      Taro.switchTab({ url: '/pages/home/index' })
    }
  }

  /** 微信一键登录：getPhoneNumber 的 code + wx.login 的 code 一起提交 */
  const onGetPhoneNumber = async (e: { detail: { code?: string; errMsg?: string } }) => {
    const phoneCode = e.detail?.code
    if (!phoneCode) {
      Taro.showToast({ title: '需要授权手机号才能登录', icon: 'none' })
      return
    }
    if (submitting) return
    setSubmitting(true)
    try {
      const loginRes = await Taro.login()
      const res = await authApi.wechatLogin({ phoneCode, wxLoginCode: loginRes.code })
      setLogin(res)
      Taro.showToast({ title: '登录成功', icon: 'success' })
      goHome()
    } catch (err) {
      const message = (err as { message?: string })?.message ?? '登录失败，请重试'
      Taro.showToast({ title: message, icon: 'none', duration: 2500 })
    } finally {
      setSubmitting(false)
    }
  }

  /** 开发登录：仅本地联调使用 */
  const onDevLogin = async () => {
    const PHONE_RE = /^1[3-9]\d{9}$/
    const devPhone = PHONE_RE.test(phone) ? phone : '13800000000'
    if (submitting) return
    setSubmitting(true)
    try {
      const res = await authApi.devLogin(devPhone)
      setLogin(res)
      Taro.showToast({ title: '开发登录成功', icon: 'success' })
      goHome()
    } catch (err) {
      Taro.showToast({ title: (err as { message?: string })?.message ?? '开发登录失败', icon: 'none', duration: 2500 })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <View className='login'>
      <View className='login__brand'>
        <Image className='login__logo' src={logoPng} mode='aspectFit' />
        <Text className='login__title'>商家短视频创作工具</Text>
        <Text className='login__sub'>AI 写文案 · 分镜脚本 · 一键出片</Text>
        <View className='login__sub-tag'>微信一键登录</View>
      </View>

      <View className='login__panel'>
        {devMode ? (
          <Button className='login__primary' onClick={onDevLogin} disabled={submitting}>
            {submitting ? '登录中…' : '进入本地开发环境'}
          </Button>
        ) : (
          <Button
            className='login__primary'
            openType='getPhoneNumber'
            onGetPhoneNumber={onGetPhoneNumber}
            disabled={submitting}
          >
            {submitting ? '登录中…' : '微信一键登录'}
          </Button>
        )}
        <View className='login__tip'>{devMode ? '当前使用本地开发账号，不触发微信手机号授权。' : <>授权即表示同意<Text className='login__link' onClick={() => void Taro.showModal({ title: '用户协议', content: '我们仅使用登录所需信息，为你提供门店管理、内容创作与成片服务。具体条款以上线版本为准。', showCancel: false })}>《用户协议》</Text>和<Text className='login__link' onClick={() => void Taro.showModal({ title: '隐私政策', content: '我们仅在提供服务所必需的范围内处理手机号、门店资料和上传素材，不会将其用于无关用途。具体政策以上线版本为准。', showCancel: false })}>《隐私政策》</Text></>}</View>
      </View>

      {devMode && (
        <View className='login__dev'>
          <View className='login__field'>
            <Text className='login__dev-label'>演示手机号</Text>
            <Text className='login__dev-phone'>13800000000</Text>
          </View>
          <Button className='login__dev-btn' onClick={onDevLogin} disabled={submitting}>
            开发登录（本地联调专用）
          </Button>
          <View className='login__dev-tip'>仅本地联调可用，生产环境不显示</View>
        </View>
      )}

      <View className='login__footer'>廊坊大帅餐饮管理有限公司</View>
    </View>
  )
}
