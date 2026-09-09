// 全局商户状态：登录态 / 会员 / 豆余额 / 当前门店

import { create } from 'zustand'
import Taro from '@tarojs/taro'
import { STORAGE_KEYS } from '../config'
import * as authApi from '../services/auth'
import * as orderApi from '../services/order'

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
  currentStoreId: string

  hydrate: () => void
  setLogin: (res: authApi.LoginResult) => void
  setStore: (storeId: string) => void
  refreshBean: () => Promise<void>
  refreshMe: () => Promise<void>
  logout: () => void
}

export const useMerchantStore = create<MerchantState>((set, get) => ({
  token: '',
  refreshToken: '',
  merchant: null,
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
      isMember: res.member.isMember,
      memberEndAt: res.member.endAt,
      available: res.bean.available,
      rechargeBalance: res.bean.balance,
      grantBalance: res.bean.grantBalance,
      frozen: res.bean.frozen,
    })
  },

  setStore: (storeId) => {
    Taro.setStorageSync(STORAGE_KEYS.currentStoreId, storeId)
    set({ currentStoreId: storeId })
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

  logout: () => {
    authApi.clearSession()
    set({
      token: '',
      refreshToken: '',
      merchant: null,
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
    })
  },
}))
