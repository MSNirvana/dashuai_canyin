import { useEffect, useState, useCallback } from 'react'
import { View, Text, Button, Input, Picker } from '@tarojs/components'
import Taro from '@tarojs/taro'
import {
  createCreation,
  getCreation,
  generateCopy,
  generateStoryboard,
  type CreationDetail,
} from '../../services/creation'
import { listStores, type StoreItem } from '../../services/store'
import { listDishes, type DishItem } from '../../services/dish'
import './edit.scss'

function newRequestId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

export default function CreationEdit() {
  const params = Taro.getCurrentInstance().router?.params ?? {}
  const [localId, setLocalId] = useState<string | undefined>(params.id)
  const [detail, setDetail] = useState<CreationDetail | null>(null)
  const [stores, setStores] = useState<StoreItem[]>([])
  const [dishes, setDishes] = useState<DishItem[]>([])
  const [storeIdx, setStoreIdx] = useState(0)
  const [dishIdx, setDishIdx] = useState(-1)
  const [title, setTitle] = useState('')
  const [copyLoading, setCopyLoading] = useState(false)
  const [boardLoading, setBoardLoading] = useState(false)

  const loadDetail = useCallback(async (id: string) => {
    setDetail(await getCreation(id))
  }, [])

  useEffect(() => {
    if (localId) {
      loadDetail(localId)
      return
    }
    listStores().then(setStores).catch(() => undefined)
  }, [localId, loadDetail])

  const onStoreChange = (e: { detail: { value: string | number } }) => {
    const idx = Number(e.detail.value)
    setStoreIdx(idx)
    setDishIdx(-1)
    const sid = stores[idx]?.id
    if (sid) listDishes(sid).then(setDishes).catch(() => undefined)
  }

  const onCreate = async () => {
    const sid = stores[storeIdx]?.id
    if (!sid) {
      Taro.showToast({ title: '请选择门店', icon: 'none' })
      return
    }
    try {
      const c = await createCreation({
        storeId: sid,
        dishId: dishIdx >= 0 ? dishes[dishIdx]?.id : undefined,
        title: title || undefined,
      })
      Taro.showToast({ title: '已创建', icon: 'success' })
      setLocalId(c.id)
    } catch {
      /* 错误已在 request 层 toast */
    }
  }

  const onGenCopy = async () => {
    if (!localId) return
    setCopyLoading(true)
    try {
      const r = await generateCopy(localId, newRequestId())
      setDetail((d) => (d ? { ...d, copyText: r.text } : d))
      Taro.showToast({ title: r.isFallbackTemplate ? '已用兜底文案' : '文案已生成', icon: 'none' })
    } catch {
      /* 2001 已 toast */
    } finally {
      setCopyLoading(false)
    }
  }

  const onGenBoard = async () => {
    if (!localId) return
    setBoardLoading(true)
    try {
      const r = await generateStoryboard(localId, newRequestId())
      if (!r.parsed) {
        Taro.showToast({ title: '分镜解析异常，请重试', icon: 'none' })
        await loadDetail(localId)
        return
      }
      await loadDetail(localId)
      Taro.showToast({ title: '分镜已生成', icon: 'success' })
    } catch {
      /* 错误已 toast */
    } finally {
      setBoardLoading(false)
    }
  }

  if (!localId) {
    return (
      <View className='cedit'>
        <View className='cedit__field'>
          <Text className='cedit__label'>门店</Text>
          <Picker mode='selector' range={stores.map((s) => s.name)} onChange={onStoreChange}>
            <View className='cedit__picker'>{stores[storeIdx]?.name || '请选择门店'}</View>
          </Picker>
        </View>
        <View className='cedit__field'>
          <Text className='cedit__label'>菜品</Text>
          <Picker
            mode='selector'
            range={['不指定', ...dishes.map((d) => d.name)]}
            onChange={(e: { detail: { value: string | number } }) => setDishIdx(Number(e.detail.value) - 1)}
            disabled={!stores[storeIdx]}
          >
            <View className='cedit__picker'>{dishIdx >= 0 ? dishes[dishIdx]?.name : '不指定（可选）'}</View>
          </Picker>
        </View>
        <View className='cedit__field'>
          <Text className='cedit__label'>标题</Text>
          <Input
            className='cedit__input'
            value={title}
            onInput={(e: { detail: { value: string } }) => setTitle(e.detail.value)}
            placeholder='选填，留空用门店+菜品名'
          />
        </View>
        <Button className='cedit__submit' onClick={onCreate}>
          创建创作
        </Button>
      </View>
    )
  }

  if (!detail) return <View className='cedit__tip'>加载中…</View>

  return (
    <View className='cedit'>
      <View className='cedit__head'>
        <Text className='cedit__htitle'>{detail.title || '未命名创作'}</Text>
        <Text className='cedit__hstore'>{detail.store?.name}</Text>
      </View>

      <View className='cedit__section'>
        <View className='cedit__secbar'>
          <Text className='cedit__sectitle'>口播文案</Text>
          <Button className='cedit__gen' size='mini' loading={copyLoading} onClick={onGenCopy}>
            生成文案
          </Button>
        </View>
        {detail.copyText ? (
          <View className='cedit__copy'>{detail.copyText}</View>
        ) : (
          <View className='cedit__ph'>尚未生成</View>
        )}
      </View>

      <View className='cedit__section'>
        <View className='cedit__secbar'>
          <Text className='cedit__sectitle'>分镜脚本（{detail.shots.length}）</Text>
          <Button className='cedit__gen' size='mini' loading={boardLoading} onClick={onGenBoard}>
            生成分镜
          </Button>
        </View>
        {detail.shots.length === 0 && <View className='cedit__ph'>尚未生成</View>}
        {detail.shots.map((s) => (
          <View className='cedit__shot' key={s.id}>
            <Text className='cedit__shotseq'>{s.seq}</Text>
            <View className='cedit__shotbody'>
              <Text className='cedit__shottype'>{s.shotType || '通用'}</Text>
              <Text className='cedit__shotline'>{s.line || s.visualReq || '—'}</Text>
            </View>
          </View>
        ))}
      </View>

      {detail.shots.length > 0 && (
        <Button
          className='cedit__next'
          onClick={() => Taro.navigateTo({ url: `/pages/creation/shots?id=${localId}` })}
        >
          下一步：上传素材
        </Button>
      )}
    </View>
  )
}
