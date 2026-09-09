import { useEffect, useState, useCallback, useMemo } from 'react'
import { View, Text, Button } from '@tarojs/components'
import Taro from '@tarojs/taro'
import {
  getCreation,
  updateShotAsset,
  type CreationDetail,
  type ShotItem,
} from '../../services/creation'
import { listShotLibrary, getShotDemoPlayUrl, type ShotLibraryItem } from '../../services/account'
import { uploadVideoFile } from '../../services/upload'
import './shots.scss'

export default function CreationShots() {
  const params = Taro.getCurrentInstance().router?.params ?? {}
  const id = params.id
  const [detail, setDetail] = useState<CreationDetail | null>(null)
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [uploading, setUploading] = useState<string | null>(null)
  const [lib, setLib] = useState<ShotLibraryItem[]>([])

  const load = useCallback(async () => {
    if (id) setDetail(await getCreation(id))
  }, [id])

  useEffect(() => {
    load()
    // 镜头库失败不阻断拍摄主流程
    listShotLibrary().then(setLib).catch(() => setLib([]))
  }, [load])

  // 按分镜类型（开场/特写/制作/试吃/卖点/收尾）归组拍摄技巧
  const tipsByType = useMemo(() => {
    const m: Record<string, ShotLibraryItem[]> = {}
    for (const it of lib) {
      const list = m[it.category] ?? (m[it.category] = [])
      list.push(it)
    }
    return m
  }, [lib])

  const onUpload = async (shot: ShotItem) => {
    if (uploading) return
    try {
      const mediaRes = (await Taro.chooseMedia({
        count: 1,
        mediaType: ['video'],
        sourceType: ['album', 'camera'],
        maxDuration: 60,
      })) as unknown as {
        tempFiles: { tempFilePath: string; duration?: number; size?: number }[]
      }
      const file = mediaRes.tempFiles[0]
      if (!file) return
      setUploading(shot.id)
      const storeId = detail?.store?.id || ''
      const asset = await uploadVideoFile({
        filePath: file.tempFilePath,
        storeId,
        // duration 单位为秒；上报时长供后端按实际时长计价（未 trim 分镜的计费依据）
        durationMs: file.duration ? Math.round(file.duration * 1000) : undefined,
        sizeBytes: file.size,
        onProgress: (p) => setProgress((m) => ({ ...m, [shot.id]: p })),
      })
      await updateShotAsset(id!, shot.id, { assetId: asset.id })
      Taro.showToast({ title: '已绑定素材', icon: 'success' })
      await load()
    } catch (e: unknown) {
      const err = e as { code?: number }
      if (err?.code !== 2001) Taro.showToast({ title: '上传失败', icon: 'none' })
    } finally {
      setUploading(null)
    }
  }

  const playDemo = async (item: ShotLibraryItem) => {
    if (!item.demoVideoKey) return
    try {
      const r = await getShotDemoPlayUrl(item.id)
      if (!r.url) {
        Taro.showToast({ title: '演示环境暂无示范视频', icon: 'none' })
        return
      }
      await Taro.previewMedia({ sources: [{ url: r.url, type: 'video' }] })
    } catch {
      Taro.showToast({ title: '播放失败', icon: 'none' })
    }
  }

  if (!detail) return <View className='cshots__tip'>加载中…<Button onClick={() => load().catch(() => undefined)}>重新加载</Button></View>
  const missingShots = detail.shots.filter((shot) => !shot.assetId)
  const ready = detail.shots.length > 0 && missingShots.length === 0 && !uploading

  return (
    <View className='cshots'>
      <View className='cshots__hint'>按分镜顺序拍摄素材并上传，单个视频建议 ≤ 1 分钟、≤ 500MB</View>
      {detail.shots.map((s) => {
        const tips = tipsByType[s.shotType ?? ''] ?? []
        return (
          <View className='cshots__card' key={s.id}>
            <View className='cshots__head'>
              <Text className='cshots__seq'>分镜 {s.seq}</Text>
              <Text className='cshots__type'>{s.shotType || '通用'}</Text>
            </View>
            <Text className='cshots__line'>{s.line || s.visualReq || '—'}</Text>
            {tips.length > 0 && (
              <View className='cshots__tipsbox'>
                <Text className='cshots__tipslabel'>怎么拍</Text>
                {tips.map((t) => (
                  <View className='cshots__tipsitem' key={t.id}>
                    <View className='cshots__tipshead'>
                      <Text className='cshots__tipsname'>{t.name}</Text>
                      {t.demoVideoKey && (
                        <Button className='cshots__demo' size='mini' onClick={() => playDemo(t)}>
                          看示范
                        </Button>
                      )}
                    </View>
                    <Text className='cshots__tipstext'>{t.tips}</Text>
                  </View>
                ))}
              </View>
            )}
            {uploading === s.id && <View className='cshots__prog'>上传中 {progress[s.id] || 0}%</View>}
            {s.assetId && uploading !== s.id && <Text className='cshots__ok'>✓ 已上传</Text>}
            {!s.assetId && uploading !== s.id && (
              <Button className='cshots__up' size='mini' onClick={() => onUpload(s)}>
                上传素材
              </Button>
            )}
          </View>
        )
      })}
      <Button
        className='cshots__next'
        disabled={!ready}
        onClick={() => ready && Taro.navigateTo({ url: `/pages/render/compose?id=${id}` })}
      >
        下一步：合成成片
      </Button>
    </View>
  )
}
