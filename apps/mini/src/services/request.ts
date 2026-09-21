// 统一请求封装：鉴权 / 平台标识 / 401 自动续期 / 错误归一化

import Taro from '@tarojs/taro'
import { BASE_URL, PLATFORM, STORAGE_KEYS } from '../config'
import { currentSessionGeneration } from '../utils/session'

export interface ApiError {
  code: number
  message: string
  traceId?: string
}

export const ERROR_TEXT: Record<number, string> = {
  1001: '登录已过期，请重新登录',
  1002: '验证码错误或已过期',
  1003: '发送过于频繁，请稍后再试',
  2001: '积分不足',
  2002: '话题稿不需要门店与菜品',
  2003: '门店数量已达上限',
  2005: '需要订阅后才能使用该功能',
  2007: '请求参数与此前提交不一致，请更换 requestId',
  2009: '门店图片无效或不属于当前门店',
  2011: '请先添加门店，再使用流量款',
  // 发布素材（标题/文案/封面）。★ 与 2005 的差别要说清：2005 是「没订阅」，
  // 2012 是「服务端还没开通这个能力」（缺出图通道）—— 后者用户自己解决不了，
  // 文案不能写得像让他去开通会员。
  2012: '发布素材功能暂未开通，请联系客服',
  2013: '请先生成一次标题与文案，再单独重出封面',
  2014: '封面生成失败，请稍后重试',
  3001: '文件超出大小限制',
  3002: '素材不存在或未就绪',
  3006: '档位不存在或未启用',
  3007: '账号未绑定微信，无法支付',
  3008: '支付功能暂未开放，请稍后再试',
  // ★ 这张表只是**兜底**（下面 request() 里 `body.message ?? ERROR_TEXT[code]`，服务端给了 message 就用服务端的）。
  //   所以措辞必须跟服务端同步，否则一旦服务端漏传 message，用户会看到一句**说错了**的提示：
  //   4001 的旧文案「已有合成任务进行中」在三档互不干扰之后就错了 —— 被占住的只是**某一个档位**，
  //   照旧文案用户会以为整页都不能提交，只能干等。
  4001: '这一档已有任务在进行中，其他档位不受影响',
  4002: '合成失败，请重试',
  4003: '请先为分镜上传素材',
  4008: '上传空间不足',
  4013: '该档位暂不可用，请先选择基础生成',
  4047: '合成任务不存在',
  5001: 'AI 服务繁忙，请稍后再试',
}

/** refresh 的结果。`sessionChanged` 表示「这次续期属于上一个会话」，调用方不得拿它的 token 重放请求。 */
interface RefreshOutcome {
  token: string | null
  sessionChanged: boolean
}

let refreshing: Promise<RefreshOutcome> | null = null

async function doRefresh(): Promise<RefreshOutcome> {
  // ★ 记下发起时的会话代次：回包落地前必须复核（见 services/auth.ts 的说明）。
  const genAtStart = currentSessionGeneration()
  const refreshToken = Taro.getStorageSync<string>(STORAGE_KEYS.refreshToken)
  if (!refreshToken) return { token: null, sessionChanged: false }

  /** 会话已经换了（退出 / 换账号）⇒ 丢弃本次回包，并告诉调用方别拿旧结论做任何事 */
  const stale = (): RefreshOutcome => ({ token: null, sessionChanged: true })

  try {
    const res = await Taro.request({
      url: `${BASE_URL}/auth/refresh`,
      method: 'POST',
      data: { refreshToken },
    })
    if (currentSessionGeneration() !== genAtStart) return stale()
    const body = res.data as { code: number; data?: { token: string; refreshToken: string } }
    if (body?.code === 0 && body.data?.token) {
      Taro.setStorageSync(STORAGE_KEYS.token, body.data.token)
      Taro.setStorageSync(STORAGE_KEYS.refreshToken, body.data.refreshToken)
      return { token: body.data.token, sessionChanged: false }
    }
  } catch {
    /* ignore */
  }
  // 失败路径同样要复核：否则会拿「旧会话续期失败」的结论去清掉别人刚登进来的登录态
  if (currentSessionGeneration() !== genAtStart) return stale()
  return { token: null, sessionChanged: false }
}

function clearLoginState() {
  Taro.removeStorageSync(STORAGE_KEYS.token)
  Taro.removeStorageSync(STORAGE_KEYS.refreshToken)
  Taro.removeStorageSync(STORAGE_KEYS.merchant)
}

// ★ 回登录页必须「幂等 + 延后」，不能立刻 switchTab。
//
// 本函数是被「请求层」触发的，而请求往往就发在**刚刚跳过去的那个页面**的 onShow/useDidShow 里
// —— 那一刻 `navigateTo` 还没有落定。此时立刻 switchTab 会把这次跳转打断，
// 微信侧报的正是 `navigateTo:fail timeout`：文案看着像「目标页加载超时」，
// 实际是导航被另一个跳转打断了。加上 fail 回调也救不回来，因为它压根没失败，是被打断。
//
// 所以：先把 auth:required 事件放出去（我的页收到会弹登录框），
// 等页栈稳定后再切 tab。`loginRedirecting` 顺便把并发 401 引发的重复跳转挡掉。
let loginRedirecting = false

function redirectToLogin() {
  Taro.eventCenter.trigger('auth:required')
  if (loginRedirecting) return
  const current = Taro.getCurrentPages().slice(-1)[0]?.route ?? ''
  if (current.includes('pages/mine')) return
  loginRedirecting = true
  setTimeout(() => {
    loginRedirecting = false
    const route = Taro.getCurrentPages().slice(-1)[0]?.route ?? ''
    if (route.includes('pages/mine')) return
    Taro.switchTab({ url: '/pages/mine/index', fail: () => undefined })
  }, 300)
}

function guideSubscription() {
  const pages = Taro.getCurrentPages()
  const current = pages[pages.length - 1]
  const route = current?.route ?? ''
  const options = (current as { options?: Record<string, string> } | undefined)?.options ?? {}
  const query = Object.keys(options)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(options[key] ?? '')}`)
    .join('&')
  const redirect = `/${route}${query ? `?${query}` : ''}`
  Taro.showModal({
    title: '需要订阅',
    content: '订阅后才能使用生成能力，前往订阅与积分页面？',
    confirmText: '去订阅',
    cancelText: '稍后再说',
  }).then((result) => {
    if (result.confirm) {
      Taro.navigateTo({ url: `/pages/recharge/index?redirect=${encodeURIComponent(redirect)}` })
    }
  })
}

/**
 * 把 Taro.request 的**网络层**失败转成可读的 ApiError。
 *
 * ★ 为什么必须转：当请求压根没到服务端时（域名不在合法域名白名单、连接被拒、超时），
 *   微信抛出的是 `{ errMsg: 'request:fail ...' }` —— 这个对象**没有 `message` 字段**。
 *   而调用方普遍写 `(err as { message?: string })?.message ?? 'XX失败，请稍后重试'`，
 *   于是真实原因被吞成一句毫无信息量的兜底文案：toast 上说"发送失败，请稍后重试"，
 *   实际可能是"域名不在白名单"或"连不上后端"，排查时只能靠猜。
 *   转成带 message 的 ApiError 后，toast 上直接能读出属于哪一类，
 *   并在括号里附带原始 errMsg，真机排查不用再捞 console。
 */
function toNetworkError(e: unknown): ApiError {
  const errMsg = (e as { errMsg?: string })?.errMsg ?? ''
  const hint = /url not in domain list/i.test(errMsg)
    ? '域名未加入小程序「合法域名」白名单'
    : /ERR_CONNECTION|ECONNREFUSED|FAILED_TO_CONNECT|fail to connect/i.test(errMsg)
      ? '连不上服务器（后端没启动／地址或端口不对／手机与电脑不同网段）'
      : /timeout/i.test(errMsg)
        ? '请求超时（网络慢或服务端无响应）'
        : '网络异常'
  return { code: -1, message: `${hint}〔${errMsg || 'request:fail'}〕` }
}

interface RequestOptions<T> {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  data?: unknown
  header?: Record<string, string>
  /** 401 时是否自动续期后重试，默认 true */
  autoRefresh?: boolean
  silent?: boolean
  timeout?: number
}

export async function request<T>(options: RequestOptions<T>): Promise<T> {
  const { url, method = 'GET', data, header = {}, autoRefresh = true, silent = false, timeout = 30000 } = options

  const send = async (token?: string | null) => {
    const storeId = Taro.getStorageSync<string>(STORAGE_KEYS.currentStoreId)
    try {
      const res = await Taro.request({
        url: `${BASE_URL}${url}`,
        method,
        data: data as never,
        timeout,
        header: {
          'content-type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'X-Platform': PLATFORM,
          ...(storeId ? { 'X-Store-Id': storeId } : {}),
          ...header,
        },
      })
      return res
    } catch (e) {
      // 网络层失败不会进到下面的 body 解析，必须在这里就转成带 message 的错误
      throw toNetworkError(e)
    }
  }

  let token = Taro.getStorageSync<string>(STORAGE_KEYS.token)
  let res = await send(token)
  let body = res.data as { code: number; message?: string; data?: T; traceId?: string }

  if (body?.code === 1001 && autoRefresh) {
    if (!refreshing) refreshing = doRefresh().finally(() => (refreshing = null))
    const outcome = await refreshing
    if (outcome.sessionChanged) {
      // ★ 会话已经换了（用户在请求飞行途中退出或换账号）。
      //   绝不能拿新账号的 token 去重放这次请求 —— 那会把「账号 A 页面上的请求」
      //   用账号 B 的身份发出去；也不能清登录态，那会把刚登录成功的 B 踢下线。
      //   如实报错，由用户重试（这一次的语义已经无法还原了）。
      throw { code: -1, message: '登录状态已变更，请重试' } satisfies ApiError
    }
    if (outcome.token) {
      res = await send(outcome.token)
      body = res.data as typeof body
    } else {
      clearLoginState()
      redirectToLogin()
    }
  }

  if (body?.code === 0) return body.data as T

  const err: ApiError = {
    code: body?.code ?? -1,
    message: body?.message ?? ERROR_TEXT[body?.code ?? -1] ?? '请求失败',
    traceId: body?.traceId,
  }
  if (!silent) {
    if (err.code === 2005) guideSubscription()
    else Taro.showToast({ title: err.message, icon: 'none', duration: 2000 })
  }
  throw err
}

export const http = {
  get: <T>(url: string, data?: unknown, opt?: Partial<RequestOptions<T>>) =>
    request<T>({ url, method: 'GET', data, ...opt }),
  post: <T>(url: string, data?: unknown, opt?: Partial<RequestOptions<T>>) =>
    request<T>({ url, method: 'POST', data, ...opt }),
  put: <T>(url: string, data?: unknown, opt?: Partial<RequestOptions<T>>) =>
    request<T>({ url, method: 'PUT', data, ...opt }),
  patch: <T>(url: string, data?: unknown, opt?: Partial<RequestOptions<T>>) =>
    request<T>({ url, method: 'PATCH', data, ...opt }),
  del: <T>(url: string, data?: unknown, opt?: Partial<RequestOptions<T>>) =>
    request<T>({ url, method: 'DELETE', data, ...opt }),
}
