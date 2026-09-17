// 个人资料（个人主页）：昵称 / 头像
//
// 头像上传**不走** services/upload.ts 的 uploadMediaFile：
// 那条链路是「门店创作素材」专用的（要 storeId、落 media_asset、计存储配额），
// 头像是商户级、且可能一张门店都没有。服务端 /profile/avatar 只把文件写进本商家前缀，
// 把对象键存进 merchant.avatar_key。
import Taro from '@tarojs/taro'
import { BASE_URL, PLATFORM, STORAGE_KEYS } from '../config'
import { http } from './request'

export interface ProfileInfo {
  id: string
  phone: string
  nickname: string | null
  /** 自传头像的对象键；为 null 表示还没自传过（展示时会回落到微信侧头像/首字母） */
  avatarKey: string | null
  /**
   * 可直接给 <Image> 用的展示地址。
   * ⚠ 服务端**现签**的，1 小时过期 ⇒ 只能放内存/state，**绝不能写进 storage**，
   *   否则下次冷启动拿到的是过期链接（表现为头像一片空白/红叉）。
   */
  avatarUrl: string | null
}

export function getProfile() {
  return http.get<ProfileInfo>('/profile/me')
}

/** 改昵称（`null` 或 `''` = 清空，展示时回落到手机号）/ 换头像（传对象键） */
export function updateProfile(input: { nickname?: string | null; avatarKey?: string }) {
  return http.patch<ProfileInfo>('/profile/me', input)
}

/**
 * 上传头像文件本体。用 Taro.uploadFile 而不是 http.post：
 * 小程序里 multipart 只能走 uploadFile（与 services/upload.ts 的本地模式分支同一套写法）。
 */
export async function uploadAvatar(filePath: string): Promise<ProfileInfo> {
  const token = Taro.getStorageSync<string>(STORAGE_KEYS.token)
  const result = await Taro.uploadFile({
    url: `${BASE_URL}/profile/avatar`,
    filePath,
    name: 'file',
    header: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Platform': PLATFORM,
    },
  })

  let body: { code?: number; message?: string; data?: ProfileInfo }
  try {
    body = JSON.parse(result.data || '{}') as typeof body
  } catch {
    throw new Error('上传服务返回格式错误')
  }
  if (result.statusCode < 200 || result.statusCode >= 300 || body.code !== 0 || !body.data) {
    throw new Error(body.message || '头像上传失败')
  }
  return body.data
}

/**
 * 选图 → 上传 的完整动作，「我的」页与个人主页共用（避免两处手抄）。
 *
 * 返回 `null` 表示**用户主动取消选图**（不是失败）——调用方据此跳过提示，
 * 否则每次点开选择器再返回都会弹一个「上传失败」，很烦人。
 */
export async function pickAndUploadAvatar(): Promise<ProfileInfo | null> {
  let filePath = ''
  try {
    const r = await Taro.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
    })
    filePath = r.tempFiles[0]?.path ?? ''
  } catch {
    return null
  }
  if (!filePath) return null
  return uploadAvatar(filePath)
}
