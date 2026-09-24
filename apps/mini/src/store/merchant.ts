// 全局商户状态：登录态 / 会员 / 积分余额 / 当前门店
// 门店是最高层：门店列表与当前门店缓存在这里，全站（菜品/创作/人设）统一跟随
// ★ 单店模型（2026-09-24）：一个账号只有一家门店，没有「切换门店」；
//   当前门店由 loadStores 钉在账号唯一门店上，门店切换器组件已删除

import { create } from 'zustand'
import Taro from '@tarojs/taro'
import { STORAGE_KEYS } from '../config'
import * as authApi from '../services/auth'
import * as orderApi from '../services/order'
import * as profileApi from '../services/profile'
import * as storeApi from '../services/store'
import type { StoreItem } from '../services/store'

export interface MerchantInfo {
  id: string
  phone: string
  nickname: string | null
  avatarUrl: string | null
  isNew: boolean
}

export interface MeInfo {
  balance: { available: string; balance: string; grantBalance: string; frozen: string }
  subscription: { active: boolean; planName: string | null; endAt: string | null; grantPoints: string }
  storage: { usedBytes: string; quotaBytes: string; subscribed: boolean }
}

interface MerchantState {
  token: string
  refreshToken: string
  merchant: MerchantInfo | null
  /**
   * 头像**展示地址**（服务端现签、1 小时过期）。
   *
   * 刻意只放内存、**不写 storage**：签名地址过期后是红叉，比回落到「首字母圆头像」难看。
   * 冷启动时会短暂显示首字母，等 refreshProfile() 回来即换成真头像。
   */
  avatarUrl: string
  isMember: boolean
  memberEndAt: string | null
  memberPlanName: string | null
  available: string
  rechargeBalance: string
  grantBalance: string
  frozen: string
  storageUsed: string
  storageQuota: string
  storageSubscribed: boolean
  /**
   * 当前门店 id（全站唯一上下文，所有内容按它隔离）。
   * ★ 单店模型（2026-09-24）下它恒等于账号**唯一**的那家门店，由 loadStores 钉住，
   *   不再有「用户切换门店」这回事。
   */
  currentStoreId: string
  /** 门店列表缓存（各页共用，避免重复请求）。★ 单店模型下最多一条 */
  stores: StoreItem[]
  storesLoadedAt: number

  hydrate: () => void
  setLogin: (res: authApi.LoginResult) => void
  setStore: (storeId: string) => void
  /** 拉取门店列表（默认 30s 内复用缓存）；★ 单店模型：总会把 currentStoreId 钉到账号唯一门店 */
  loadStores: (force?: boolean) => Promise<StoreItem[]>
  currentStore: () => StoreItem | undefined
  refreshBean: () => Promise<void>
  refreshMe: () => Promise<void>
  /** 拉取商户资料（昵称 + 头像展示地址）。登录态下才有意义，未登录直接返回 */
  refreshProfile: () => Promise<void>
  /** 写入资料结果（个人主页改完昵称/头像后调用，避免再发一次请求） */
  setProfile: (p: { nickname: string | null; avatarUrl: string | null }) => void
  logout: () => void
}

export const useMerchantStore = create<MerchantState>((set, get) => ({
  token: '',
  refreshToken: '',
  merchant: null,
  avatarUrl: '',
  isMember: false,
  memberEndAt: null,
  memberPlanName: null,
  available: '0',
  rechargeBalance: '0',
  grantBalance: '0',
  frozen: '0',
  storageUsed: '0',
  storageQuota: '0',
  storageSubscribed: false,
  currentStoreId: '',
  stores: [],
  storesLoadedAt: 0,

  hydrate: () => {
    try {
      const token = Taro.getStorageSync<string>(STORAGE_KEYS.token) ?? ''
      const refreshToken = Taro.getStorageSync<string>(STORAGE_KEYS.refreshToken) ?? ''
      const merchant = Taro.getStorageSync<MerchantInfo>(STORAGE_KEYS.merchant) || null
      const currentStoreId = Taro.getStorageSync<string>(STORAGE_KEYS.currentStoreId) ?? ''
      set({ token, refreshToken, merchant, currentStoreId })
    } catch {
      /* storage 不可用时忽略 */
    }
  },

  setLogin: (res) => {
    authApi.saveSession(res)
    set({
      token: res.token,
      refreshToken: res.refreshToken,
      merchant: res.merchant,
      // 换账号登录：上一个账号的头像签名地址必须清掉，否则会闪出别人的头像
      avatarUrl: '',
      isMember: res.member.isMember,
      memberEndAt: res.member.endAt,
      available: res.bean.available,
      rechargeBalance: res.bean.balance,
      grantBalance: res.bean.grantBalance,
      frozen: res.bean.frozen,
      // 换账号登录：门店缓存作废，由首页 / 我的页重新拉取（原「门店切换器」已于 2026-09-24 删除）
      stores: [],
      storesLoadedAt: 0,
    })
  },

  setStore: (storeId) => {
    Taro.setStorageSync(STORAGE_KEYS.currentStoreId, storeId)
    set({ currentStoreId: storeId })
  },

  loadStores: async (force = false) => {
    const { stores, storesLoadedAt, token } = get()
    // 未登录不请求；30s 内命中缓存
    if (!token) return []
    if (!force && stores.length && Date.now() - storesLoadedAt < 30_000) return stores
    const list = await storeApi.listStores()
    set({ stores: list, storesLoadedAt: Date.now() })

    /**
     * ★ 单店模型（2026-09-24）：currentStoreId 必须**钉在账号唯一门店上**，
     *   而不是沿用「上次选中的那家」。
     *
     * 旧写法只在「当前门店不在列表里」时才回落，于是本地 storage 里残留的旧 id
     * （历史第二家店、或曾切过去的店）会一直生效。多门店时代这没问题（那家店还在列表里，
     * 用户自己会切回来）；**现在没有切换入口了** —— 残留 id 一旦不是默认门店，
     * 用户就永远看不到自己门店的菜品/创作，且无从自救。
     *
     * 口径与服务端 listStores 的排序一致：优先默认门店，无默认则取第一家
     * （服务端 orderBy: isDefault desc, createdAt asc）。
     */
    const primary = list.find((s) => s.isDefault) ?? list[0]
    if (primary && primary.id !== get().currentStoreId) {
      get().setStore(primary.id)
    } else if (!primary && get().currentStoreId) {
      // 门店被删光：清空当前门店，各页显示建店引导
      Taro.removeStorageSync(STORAGE_KEYS.currentStoreId)
      set({ currentStoreId: '' })
    }
    return list
  },

  currentStore: () => {
    const { stores, currentStoreId } = get()
    return stores.find((s) => s.id === currentStoreId)
  },

  refreshBean: async () => {
    await get().refreshMe()
  },

  refreshMe: async () => {
    if (!get().token) return
    try {
      const me = await orderApi.getMe()
      set({
        available: me.balance.available,
        rechargeBalance: me.balance.balance,
        grantBalance: me.balance.grantBalance,
        frozen: me.balance.frozen,
        isMember: me.subscription.active,
        memberEndAt: me.subscription.endAt,
        memberPlanName: me.subscription.planName,
        storageUsed: me.storage.usedBytes,
        storageQuota: me.storage.quotaBytes,
        storageSubscribed: me.storage.subscribed,
      })
    } catch (error) {
      throw error
    }
  },

  refreshProfile: async () => {
    if (!get().token) return
    const p = await profileApi.getProfile()
    get().setProfile({ nickname: p.nickname, avatarUrl: p.avatarUrl })
  },

  setProfile: ({ nickname, avatarUrl }) => {
    const merchant = get().merchant
    if (merchant) {
      // 昵称写进 storage（稳定值，下次冷启动直接可用）；
      // avatarUrl 是 1 小时过期的签名地址，只进内存 —— 见 state 里的说明
      const next: MerchantInfo = { ...merchant, nickname }
      Taro.setStorageSync(STORAGE_KEYS.merchant, next)
      set({ merchant: next, avatarUrl: avatarUrl ?? '' })
      return
    }
    set({ avatarUrl: avatarUrl ?? '' })
  },

  logout: () => {
    authApi.clearSession()
    set({
      token: '',
      refreshToken: '',
      merchant: null,
      avatarUrl: '',
      isMember: false,
      memberEndAt: null,
      available: '0',
      rechargeBalance: '0',
      grantBalance: '0',
      frozen: '0',
      storageUsed: '0',
      storageQuota: '0',
      storageSubscribed: false,
      currentStoreId: '',
      stores: [],
      storesLoadedAt: 0,
    })
  },
}))
