import { useEffect, useState } from 'react'
import { View, Text, Input, Textarea, Picker, Image, Video } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { useRouter } from '@tarojs/taro'
import { createStore, updateStore, getStore, getStoreMediaUrl, type StoreInput, type StoreItem } from '../../services/store'
import { uploadMediaFile } from '../../services/upload'
import { cityOptions, districtOptions, provinceOptions, resolveAreaNames } from '../../services/area'
import { useMerchantStore } from '../../store/merchant'
import { readRouteId, isBrokenRouteId } from '../../utils/route-id'
import './edit.scss'

interface FormState {
  name: string
  category: string
  province: string
  city: string
  district: string
  address: string
  coverKey: string
  intro: string
  videoKey: string
}

const EMPTY: FormState = {
  name: '',
  category: '',
  province: '',
  city: '',
  district: '',
  address: '',
  coverKey: '',
  intro: '',
  videoKey: '',
}

export default function StoreEditPage() {
  const router = useRouter()
  /**
   * 要编辑的门店编号；`undefined` = 新建。
   * ★ 入口编号要校验：`?id=undefined` 会让 URL 看着正常，但 `getStore('undefined')`
   *   服务端回一句「参数不合法」，页面只弹「门店不存在」—— 用户看不出是链接坏了
   *   （详见 utils/route-id.ts）。
   */
  const id = readRouteId(router.params) ?? undefined
  /**
   * 带了编号但不合法。
   * ★ 不能当成「新建」：多门店时代保存会**新建出另一家门店**，而用户以为在改的那家原样没动；
   *   单店模型（2026-09-24）下服务端会直接拒绝（一个账号只能一家门店），用户拿到的
   *   只是一句看不懂的「门店数量已达上限」。
   *   所以这种链接必须拦住，而不是静默退化成另一种合法语义。
   */
  const idBroken = isBrokenRouteId(router.params)
  const loadStores = useMerchantStore((s) => s.loadStores)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pendingImage, setPendingImage] = useState<{ path: string; size: number } | null>(null)
  const [coverPreview, setCoverPreview] = useState('')
  const [pendingVideo, setPendingVideo] = useState<{ path: string; size: number; durationMs?: number; thumb?: string } | null>(null)
  const [videoPreview, setVideoPreview] = useState('')
  const [uploadingVideo, setUploadingVideo] = useState(false)

  /**
   * 编辑对象是否加载失败。
   * ★ 失败绝不能落进「空表单可保存」：保存会把 intro/coverKey/videoKey 以 null 写回，
   *   门店的简介、主图、视频被**全部清空** —— 与 dish/edit 是同一条数据丢失链。
   */
  const [loadFailed, setLoadFailed] = useState(false)

  const loadDetail = () => {
    if (!id) return
    setLoadFailed(false)
    getStore(id)
      .then((s: StoreItem) => {
        const area = resolveAreaNames(s)
        setForm({
          name: s.name,
          category: s.category ?? '',
          province: area.province,
          city: area.city,
          district: area.district,
          address: s.address ?? '',
          coverKey: s.coverKey ?? '',
          intro: s.intro ?? '',
          videoKey: s.videoKey ?? '',
        })
        if (s.coverKey) {
          getStoreMediaUrl(s.coverKey).then((r) => setCoverPreview(r.url ?? '')).catch(() => undefined)
        }
        if (s.videoKey) {
          getStoreMediaUrl(s.videoKey).then((r) => setVideoPreview(r.url ?? '')).catch(() => undefined)
        }
      })
      .catch(() => setLoadFailed(true))
      .finally(() => setLoaded(true))
  }

  useEffect(() => {
    if (!id) {
      setLoaded(true)
      return
    }
    loadDetail()
  }, [id])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const provinceIndex = Math.max(0, provinceOptions.findIndex((o) => o.name === form.province))
  const provinceCode = provinceOptions[provinceIndex]?.code ?? ''
  const cities = cityOptions(provinceCode)
  const cityIndex = Math.max(0, cities.findIndex((o) => o.name === form.city))
  const cityCode = cities[cityIndex]?.code ?? ''
  const districts = districtOptions(cityCode)
  const districtIndex = Math.max(0, districts.findIndex((o) => o.name === form.district))

  const pickImage = async () => {
    if (saving) return
    try {
      const r = await Taro.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'] })
      const file = r.tempFiles[0]
      if (!file) return
      setPendingImage({ path: file.path, size: file.size })
      setCoverPreview(file.path)
      set('coverKey', '')
    } catch {
      // 用户取消选择时不提示错误
    }
  }

  const removeImage = () => {
    setPendingImage(null)
    setCoverPreview('')
    set('coverKey', '')
  }

  const pickVideo = async () => {
    if (saving || uploadingVideo) return
    try {
      const r = await Taro.chooseMedia({
        count: 1,
        mediaType: ['video'],
        sourceType: ['album', 'camera'],
        maxDuration: 60,
      })
      const file = r.tempFiles[0]
      if (!file) return
      setPendingVideo({
        path: file.tempFilePath,
        size: file.size,
        durationMs: file.duration ? Math.round(file.duration * 1000) : undefined,
        thumb: file.thumbTempFilePath,
      })
      setVideoPreview(file.tempFilePath)
      set('videoKey', '')
    } catch {
      // 用户取消选择时不提示错误
    }
  }

  const removeVideo = () => {
    setPendingVideo(null)
    setVideoPreview('')
    set('videoKey', '')
  }

  const onSubmit = async () => {
    // ★ 数据没加载成功就**绝不保存**：此刻表单是空的，保存 = 清空门店简介/主图/视频
    if (loadFailed) { Taro.showToast({ title: '门店还没加载成功，不能保存', icon: 'none' }); return }
    if (saving || uploadingVideo) return
    if (!form.name.trim()) {
      Taro.showToast({ title: '请填写门店名称', icon: 'none' })
      return
    }
    setSaving(true)
    let storeId = id
    let uploadedCoverKey = form.coverKey || null
    let uploadedVideoKey = form.videoKey || null
    try {
      const basePayload: StoreInput = {
        name: form.name.trim(),
        category: form.category || undefined,
        province: form.province || undefined,
        city: form.city || undefined,
        district: form.district || undefined,
        address: form.address || undefined,
        intro: form.intro.trim() || null,
        // ★ 2026-09-24 单店模型：**不再传 isDefault**。账号只有一家门店，它必然是默认门店，
        //   没有「设/取消默认」这回事（路由层也已不再接受该字段）。
      }
      if (storeId) {
        if (pendingImage) {
          const asset = await uploadMediaFile({ filePath: pendingImage.path, storeId, type: 'IMAGE', sizeBytes: pendingImage.size, ownerType: 'STORE' })
          uploadedCoverKey = asset.cosKey
        }
        if (pendingVideo) {
          setUploadingVideo(true)
          const asset = await uploadMediaFile({
            filePath: pendingVideo.path,
            storeId,
            type: 'VIDEO',
            sizeBytes: pendingVideo.size,
            durationMs: pendingVideo.durationMs,
            thumbFilePath: pendingVideo.thumb,
            ownerType: 'STORE',
          })
          setUploadingVideo(false)
          uploadedVideoKey = asset.cosKey
        }
        await updateStore(storeId, { ...basePayload, coverKey: uploadedCoverKey, videoKey: uploadedVideoKey })
      } else {
        const created = await createStore(basePayload)
        storeId = created.id
        const patch: StoreInput = { ...basePayload }
        if (pendingImage) {
          const asset = await uploadMediaFile({ filePath: pendingImage.path, storeId, type: 'IMAGE', sizeBytes: pendingImage.size, ownerType: 'STORE' })
          patch.coverKey = asset.cosKey
        }
        if (pendingVideo) {
          setUploadingVideo(true)
          const asset = await uploadMediaFile({
            filePath: pendingVideo.path,
            storeId,
            type: 'VIDEO',
            sizeBytes: pendingVideo.size,
            durationMs: pendingVideo.durationMs,
            thumbFilePath: pendingVideo.thumb,
            ownerType: 'STORE',
          })
          setUploadingVideo(false)
          patch.videoKey = asset.cosKey
        }
        if (patch.coverKey !== undefined || patch.videoKey !== undefined) {
          await updateStore(storeId, patch)
        }
      }
      Taro.showToast({ title: '已保存', icon: 'success' })
      // 刷新全局门店缓存：各页立即看到新门店或新名称（原「门店切换器」已随单店模型删除）
      await loadStores(true).catch(() => undefined)
      Taro.navigateBack()
    } catch {
      if (!id && storeId) {
        Taro.showToast({ title: '门店已创建，图片未保存', icon: 'none' })
        Taro.navigateBack()
      }
      else Taro.showToast({ title: '保存失败，请重试', icon: 'none' })
    } finally {
      setSaving(false)
      setUploadingVideo(false)
    }
  }

  if (!loaded) return <View className='store-edit store-edit--loading'>加载中…</View>

  // ★ 加载失败：整页只给重试，绝不渲染空表单（空表单保存 = 清空门店简介/主图/视频）
  if (loadFailed) {
    return (
      <View className='store-edit store-edit--loading'>
        <View style={{ padding: '80rpx 40rpx', textAlign: 'center' }}>
          <Text style={{ display: 'block', marginBottom: '32rpx' }}>门店加载失败，请检查网络后重试。</Text>
          <View className='ds-btn ds-btn--primary' style={{ display: 'inline-flex' }} onClick={() => { setLoaded(false); loadDetail() }}><Text>重新加载</Text></View>
        </View>
      </View>
    )
  }

  // 坏编号：既不能请求，也不能退化成「新建」（单店模型下会被服务端直接拒绝）。
  // 唯一的真出路是回「我的 → 门店资料」重新进入。
  if (idBroken) {
    return (
      <View className='store-edit store-edit--loading'>
        链接里的门店编号有误，请回到「我的 → 门店资料」重新进入。
      </View>
    )
  }

  return (
    <View className='store-edit'>
      <View className='store-edit__form'>
        <View className='field'>
          <Text className='field__label'>门店图片</Text>
          {coverPreview ? (
            <View className='store-cover'>
              <Image className='store-cover__image' src={coverPreview} mode='aspectFill' />
              <View className='store-cover__actions'>
                <View className='store-cover__action' onClick={pickImage}>更换</View>
                <View className='store-cover__action store-cover__action--danger' onClick={removeImage}>删除</View>
              </View>
            </View>
          ) : (
            <View className='store-cover store-cover--empty' onClick={pickImage}>
              <Text>上传门店主图</Text>
            </View>
          )}
        </View>

        <View className='field'>
          <Text className='field__label'>门店视频</Text>
          {videoPreview ? (
            <View className='store-video'>
              <Video className='store-video__player' src={videoPreview} controls showCenterPlayBtn={false} />
              <View className='store-video__actions'>
                <View className='store-video__action' onClick={pickVideo}>更换</View>
                <View className='store-video__action store-video__action--danger' onClick={removeVideo}>删除</View>
              </View>
            </View>
          ) : (
            <View className='store-video store-video--empty' onClick={pickVideo}>
              <Text>{uploadingVideo ? '上传中…' : '上传门店视频（选填）'}</Text>
            </View>
          )}
        </View>

        <View className='field'>
          <Text className='field__label'>门店名称<Text className='field__req'>*</Text></Text>
          <Input
            className='field__input'
            placeholder='如：大帅烧烤（中关村店）'
            value={form.name}
            onInput={(e) => set('name', e.detail.value)}
            maxlength={128}
          />
        </View>

        <View className='field'>
          <Text className='field__label'>品类</Text>
          <Input
            className='field__input'
            placeholder='如：烧烤 / 火锅 / 川菜'
            value={form.category}
            onInput={(e) => set('category', e.detail.value)}
            maxlength={64}
          />
        </View>

        <View className='field field--region'>
          <View className='field__col'>
            <Text className='field__label'>省/地区</Text>
            <Picker mode='selector' range={provinceOptions.map((o) => o.name)} value={provinceIndex} onChange={(e) => {
              const next = provinceOptions[Number(e.detail.value)]
              const nextCities = cityOptions(next?.code ?? '')
              const nextCity = nextCities[0]
              const nextDistrict = nextCity ? districtOptions(nextCity.code)[0] : undefined
              setForm((f) => ({ ...f, province: next?.name ?? '', city: nextCity?.name ?? '', district: nextDistrict?.name ?? '' }))
            }}>
              <View className='field__picker'>{form.province || '选择省/地区'}</View>
            </Picker>
          </View>
          <View className='field__col'>
            <Text className='field__label'>城市</Text>
            <Picker disabled={!form.province} mode='selector' range={cities.map((o) => o.name)} value={cityIndex} onChange={(e) => {
              const nextCity = cities[Number(e.detail.value)]
              const nextDistrict = nextCity ? districtOptions(nextCity.code)[0] : undefined
              setForm((f) => ({ ...f, city: nextCity?.name ?? '', district: nextDistrict?.name ?? '' }))
            }}>
              <View className={`field__picker ${!form.province ? 'field__picker--disabled' : ''}`}>{form.city || '请先选择省/地区'}</View>
            </Picker>
          </View>
          <View className='field__col'>
            <Text className='field__label'>区县</Text>
            <Picker disabled={!form.city} mode='selector' range={districts.map((o) => o.name)} value={districtIndex} onChange={(e) => set('district', districts[Number(e.detail.value)]?.name ?? '')}>
              <View className={`field__picker ${!form.city ? 'field__picker--disabled' : ''}`}>{form.district || (form.city ? '选择区县' : '请先选择城市')}</View>
            </Picker>
          </View>
        </View>

        <View className='field'>
          <Text className='field__label'>详细地址</Text>
          <Textarea
            className='field__textarea'
            placeholder='街道 / 门牌 / 楼栋 / 单元（可换行）'
            value={form.address}
            onInput={(e) => set('address', e.detail.value)}
            maxlength={255}
            autoHeight
          />
        </View>

        <View className='field'>
          <Text className='field__label'>门店介绍</Text>
          <Textarea
            className='field__textarea'
            placeholder='一两句话说明门店特色，如：开了 12 年的社区烧烤店，招牌是炭烤羊排（可换行）'
            value={form.intro}
            onInput={(e) => set('intro', e.detail.value)}
            maxlength={500}
            autoHeight
          />
        </View>

        {/* ★ 2026-09-24 单店模型：原「设为默认门店」开关删除 ——
            账号只有一家门店，它必然是默认门店，开关开到哪一边都不改变任何事。 */}
      </View>

      <View className='store-edit__footer'>
        <View className={`store-edit__save ${saving || uploadingVideo ? 'store-edit__save--disabled' : ''}`} onClick={onSubmit}>
          <Text>{id ? '保存修改' : '创建门店'}</Text>
        </View>
      </View>
    </View>
  )
}
