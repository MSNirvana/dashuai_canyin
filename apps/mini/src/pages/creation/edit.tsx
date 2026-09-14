import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, Button, Input, Textarea, Picker } from '@tarojs/components'
import Taro from '@tarojs/taro'
import {
  createCreation,
  getCreation,
  generateCopy,
  generateStoryboard,
  updateCreation,
  updateShotContent,
  COPY_TRACK_OPTIONS,
  COMPLEXITY_OPTIONS,
  type CreationDetail,
  type CopyTrack,
  type Complexity,
  type ShotItem,
} from '../../services/creation'
import { type StoreItem } from '../../services/store'
import { getWork, type WorkRecipe } from '../../services/work'
import { listDishes, type DishItem } from '../../services/dish'
import { useMerchantStore } from '../../store/merchant'
import StoreSwitcher from '../../components/store-switcher'
import Segmented from '../../components/segmented'
import Steps from '../../components/steps'
import './edit.scss'

function newRequestId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** 镜头分类（与镜头库 category 对齐） */
const SHOT_TYPES = ['开场', '口播', '特写', '原料', '制作', '环境', '试吃', '卖点', '收尾']
/** 景别 */
const SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写', '大特写']

/** 四步流程条 */
const STEP_LABELS = ['文案', '分镜', '素材', '成片']

interface ShotDraft {
  shotType: string
  shotSize: string
  durationSuggest: string
  line: string
  visualReq: string
}

/** 单条分镜的可复制文本 */
function shotToText(s: ShotItem) {
  const parts = [`分镜 ${s.seq}`]
  if (s.shotType) parts.push(`镜头：${s.shotType}`)
  if (s.shotSize) parts.push(`景别：${s.shotSize}`)
  if (s.durationSuggest) parts.push(`时长：${s.durationSuggest}s`)
  if (s.libraryShot?.name) parts.push(`手法：${s.libraryShot.name}`)
  const head = parts.join('｜')
  const body = [s.line ? `台词：${s.line}` : '', s.visualReq ? `画面：${s.visualReq}` : '']
    .filter(Boolean)
    .join('\n')
  return body ? `${head}\n${body}` : head
}

export default function CreationEdit() {
  const params = Taro.getCurrentInstance().router?.params ?? {}
  // 从「优秀作品」带过来的同款配方：workId 预填，auto=1 时创建后自动跑 AI
  const workId = params.workId ?? ''
  const autoMode = params.auto === '1'
  const currentStoreId = useMerchantStore((s) => s.currentStoreId)
  const setStore = useMerchantStore((s) => s.setStore)
  const loadStores = useMerchantStore((s) => s.loadStores)
  const [localId, setLocalId] = useState<string | undefined>(params.id)
  const [detail, setDetail] = useState<CreationDetail | null>(null)
  const [stores, setStores] = useState<StoreItem[]>([])
  const [dishes, setDishes] = useState<DishItem[]>([])
  const [storeIdx, setStoreIdx] = useState(0)
  const [dishIdx, setDishIdx] = useState(-1)
  const [title, setTitle] = useState('')
  const [copyLoading, setCopyLoading] = useState(false)
  const [boardLoading, setBoardLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  // ── 同款配方（来自优秀作品） ──
  const [workRecipe, setWorkRecipe] = useState<WorkRecipe | null>(null)
  const [workTitle, setWorkTitle] = useState('')
  const [workLoaded, setWorkLoaded] = useState(false)
  const [autoRunning, setAutoRunning] = useState(false)
  /** 一键生成只允许消费一次，避免返回本页时重复扣豆 */
  const autoPendingRef = useRef(autoMode)

  // 文案四款 + 分镜复杂度（新建时先本地选，创建后落库）
  const [track, setTrack] = useState<CopyTrack>('TRAFFIC')
  const [complexity, setComplexity] = useState<Complexity>('COMPLEX')
  // 文案编辑态
  const [editingCopy, setEditingCopy] = useState(false)
  const [copyDraft, setCopyDraft] = useState('')
  // 分镜编辑态
  const [editingShot, setEditingShot] = useState<string | null>(null)
  const [shotDraft, setShotDraft] = useState<ShotDraft>({
    shotType: '',
    shotSize: '',
    durationSuggest: '',
    line: '',
    visualReq: '',
  })

  const loadDetail = useCallback(async (id: string) => {
    const d = await getCreation(id)
    setDetail(d)
    if (d.track === 'TRAFFIC' || d.track === 'INTRO' || d.track === 'QUALITY' || d.track === 'RECOMMEND') setTrack(d.track)
    if (d.complexity === 'SIMPLE' || d.complexity === 'COMPLEX' || d.complexity === 'FINE') setComplexity(d.complexity)
  }, [])

  /** 拉取同款配方：预填文案款式 / 镜头复杂度 / 标题，用户仍可自行改 */
  useEffect(() => {
    if (!workId) return
    let cancelled = false
    void (async () => {
      try {
        const w = await getWork(workId)
        if (cancelled) return
        const r = w.recipeJson ?? {}
        setWorkTitle(w.title)
        setWorkRecipe(r)
        if (r.track === 'TRAFFIC' || r.track === 'INTRO' || r.track === 'QUALITY' || r.track === 'RECOMMEND') setTrack(r.track)
        if (r.complexity === 'SIMPLE' || r.complexity === 'COMPLEX' || r.complexity === 'FINE') setComplexity(r.complexity)
        if (r.titleHint) setTitle(r.titleHint)
      } catch {
        if (!cancelled) {
          // 配方拉不到不阻断建创作，退回让用户手选
          setWorkRecipe(null)
          Taro.showToast({ title: '同款配方加载失败，可手动选择', icon: 'none' })
        }
      } finally {
        if (!cancelled) setWorkLoaded(true)
      }
    })()
    return () => { cancelled = true }
  }, [workId])

  // 新建创作：门店默认取左上角当前门店（门店是最高层，创作跟随门店）
  useEffect(() => {
    if (localId) {
      loadDetail(localId)
      return
    }
    let cancelled = false
    void (async () => {
      const list = await loadStores().catch(() => [] as StoreItem[])
      if (cancelled) return
      setStores(list)
      const idx = Math.max(0, list.findIndex((s) => s.id === currentStoreId))
      setStoreIdx(idx)
      const sid = list[idx]?.id
      if (sid) listDishes(sid).then(setDishes).catch(() => undefined)
    })()
    return () => { cancelled = true }
  }, [localId, loadDetail])

  const onStoreChange = (e: { detail: { value: string | number } }) => {
    const idx = Number(e.detail.value)
    setStoreIdx(idx)
    setDishIdx(-1)
    const sid = stores[idx]?.id
    if (sid) {
      // 同步为全局当前门店，保证首页/菜品/人设上下文一致
      setStore(sid)
      listDishes(sid).then(setDishes).catch(() => undefined)
    }
  }

  // 从左上角切换器换店时，表单里的门店与菜品同步跟随
  useEffect(() => {
    if (localId || !stores.length) return
    const idx = stores.findIndex((s) => s.id === currentStoreId)
    if (idx < 0 || idx === storeIdx) return
    setStoreIdx(idx)
    setDishIdx(-1)
    listDishes(currentStoreId).then(setDishes).catch(() => undefined)
  }, [currentStoreId, stores])

  /**
   * 一键生成：按同款配方自动跑「文案 → 分镜」。
   * 失败只提示不阻断，用户可在页面内手动重试（不会重复扣豆：失败会全额解冻）。
   */
  const runAuto = async (id: string) => {
    setAutoRunning(true)
    try {
      const cr = await generateCopy(id, newRequestId(), track)
      const br = await generateStoryboard(id, newRequestId(), complexity)
      await loadDetail(id)
      if (!br.parsed) Taro.showToast({ title: '分镜解析异常，请手动重试', icon: 'none' })
      else if (cr.isFallbackTemplate || br.isFallbackTemplate) Taro.showToast({ title: 'AI 繁忙，已用兜底内容', icon: 'none' })
      else Taro.showToast({ title: `同款已生成：文案 + ${br.shots.length} 个分镜`, icon: 'none' })
    } catch {
      Taro.showToast({ title: '自动生成中断，可在页面内手动重试', icon: 'none' })
    } finally {
      setAutoRunning(false)
    }
  }

  const onCreate = async () => {
    const sid = stores[storeIdx]?.id
    if (!sid) {
      Taro.showToast({ title: '请选择门店', icon: 'none' })
      return
    }
    if (creating) return
    setCreating(true)
    try {
      const c = await createCreation({
        storeId: sid,
        dishId: dishIdx >= 0 ? dishes[dishIdx]?.id : undefined,
        title: title || undefined,
        track,
        complexity,
      })
      setLocalId(c.id)
      if (autoPendingRef.current) {
        // 只消费一次：后续返回本页不再自动生成
        autoPendingRef.current = false
        await runAuto(c.id)
      } else {
        Taro.showToast({ title: workRecipe ? '已套用同款配方' : '已创建', icon: 'success' })
      }
    } catch {
      /* 错误已在 request 层 toast */
    } finally {
      setCreating(false)
    }
  }

  /** 选款式/复杂度：本地即时生效，并静默落库，避免下次进入丢失 */
  const onPickTrack = (v: string) => {
    const value = v as CopyTrack
    setTrack(value)
    if (localId) updateCreation(localId, { track: value }).catch(() => undefined)
  }
  const onPickComplexity = (v: string) => {
    const value = v as Complexity
    setComplexity(value)
    if (localId) updateCreation(localId, { complexity: value }).catch(() => undefined)
  }

  /** 生成 / 重新生成文案 */
  const onGenCopy = async () => {
    if (!localId) return
    setCopyLoading(true)
    try {
      const r = await generateCopy(localId, newRequestId(), track)
      setDetail((d) => (d ? { ...d, copyText: r.text, track: r.track, trackLabel: r.trackLabel } : d))
      setEditingCopy(false)
      Taro.showToast({ title: r.isFallbackTemplate ? 'AI 繁忙，已用兜底文案' : '文案已生成', icon: 'none' })
    } catch {
      /* 2001 / 2005 已 toast */
    } finally {
      setCopyLoading(false)
    }
  }

  const onEditCopy = () => {
    setCopyDraft(detail?.copyText ?? '')
    setEditingCopy(true)
  }

  const onSaveCopy = async () => {
    if (!localId) return
    try {
      const d = await updateCreation(localId, { copyText: copyDraft })
      setDetail((prev) => (prev ? { ...prev, copyText: d.copyText } : prev))
      setEditingCopy(false)
      Taro.showToast({ title: '已保存', icon: 'success' })
    } catch {
      /* 已 toast */
    }
  }

  const onCopyText = (text: string, label = '已复制') => {
    if (!text) {
      Taro.showToast({ title: '暂无可复制内容', icon: 'none' })
      return
    }
    Taro.setClipboardData({ data: text })
      .then(() => Taro.showToast({ title: label, icon: 'none' }))
      .catch(() => undefined)
  }

  /** 生成 / 重新生成分镜 */
  const onGenBoard = async () => {
    if (!localId) return
    setBoardLoading(true)
    try {
      const r = await generateStoryboard(localId, newRequestId(), complexity)
      if (!r.parsed) {
        Taro.showToast({ title: '分镜解析异常，请重试', icon: 'none' })
        await loadDetail(localId)
        return
      }
      await loadDetail(localId)
      Taro.showToast({
        title: r.isFallbackTemplate ? `AI 繁忙，已用兜底分镜（${r.shots.length}）` : `已生成 ${r.shots.length} 个分镜`,
        icon: 'none',
      })
    } catch {
      /* 错误已 toast */
    } finally {
      setBoardLoading(false)
    }
  }

  const onStartEditShot = (s: ShotItem) => {
    setEditingShot(s.id)
    setShotDraft({
      shotType: s.shotType ?? '',
      shotSize: s.shotSize ?? '',
      durationSuggest: s.durationSuggest ? String(s.durationSuggest) : '',
      line: s.line ?? '',
      visualReq: s.visualReq ?? '',
    })
  }

  const onSaveShot = async (shotId: string) => {
    if (!localId) return
    try {
      const dur = Number(shotDraft.durationSuggest)
      await updateShotContent(localId, shotId, {
        shotType: shotDraft.shotType || null,
        shotSize: shotDraft.shotSize || null,
        durationSuggest: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : null,
        line: shotDraft.line,
        visualReq: shotDraft.visualReq,
      })
      setEditingShot(null)
      await loadDetail(localId)
      Taro.showToast({ title: '分镜已保存', icon: 'success' })
    } catch {
      /* 已 toast */
    }
  }

  // 同款配方的可读文案（预填提示与详情页保持同一套字典）
  const trackLabel = COPY_TRACK_OPTIONS.find((o) => o.value === track)?.label ?? ''
  const complexityLabel = COMPLEXITY_OPTIONS.find((o) => o.value === complexity)?.label ?? ''

  // ───────────── 新建创作（未落库前） ─────────────
  if (!localId) {
    return (
      <View className='cedit'>
        <View className='cedit__bar'>
          <StoreSwitcher />
          <Text className='cedit__barhint'>创作归属该门店</Text>
        </View>

        <View className='cedit__new-head'>
          <Text className='cedit__new-kicker'>NEW PROJECT</Text>
          <Text className='cedit__new-title'>今天想为哪道菜拍一条？</Text>
          <Text className='cedit__new-desc'>选好门店、菜品和表达方向，AI 会帮你把想法整理成文案与分镜。</Text>
        </View>

        <View className='cedit__card'>
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
          <View className='cedit__field cedit__field--last'>
            <Text className='cedit__label'>标题</Text>
            <Input
              className='cedit__input'
              value={title}
              onInput={(e: { detail: { value: string } }) => setTitle(e.detail.value)}
              placeholder='选填，留空用门店+菜品名'
              placeholderClass='cedit__ph'
            />
          </View>
        </View>

        {/* 来自「优秀作品」的同款配方：只预填，不替用户做决定 */}
        {!!workId && (
          <View className='cedit__recipe'>
            <View className='cedit__recipe-head'>
              <Text className='cedit__recipe-badge'>同款配方</Text>
              <Text className='cedit__recipe-title'>{workTitle || '优秀作品'}</Text>
            </View>
            <Text className='cedit__recipe-desc'>
              {!workLoaded
                ? '正在读取配方…'
                : workRecipe
                  ? `已预填「${trackLabel}」+「${complexityLabel}」，可自行调整`
                  : '配方读取失败，请手动选择文案款式与镜头复杂度'}
            </Text>
            {autoMode && workLoaded && (
              <Text className='cedit__recipe-warn'>
                {workRecipe
                  ? '创建后将自动生成文案与分镜，会消耗 AI 豆'
                  : '自动生成已跳过，请手动点击生成'}
              </Text>
            )}
          </View>
        )}

        <View className='cedit__card'>
          <Text className='cedit__sectitle'>文案款式</Text>
          <Text className='cedit__hint'>决定 AI 写文案的侧重点</Text>
          <Segmented
            options={COPY_TRACK_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            value={track}
            onChange={onPickTrack}
          />
          <Text className='cedit__desc'>{COPY_TRACK_OPTIONS.find((o) => o.value === track)?.desc}</Text>
        </View>

        <View className='cedit__card'>
          <Text className='cedit__sectitle'>镜头复杂度</Text>
          <Text className='cedit__hint'>自动决定分镜数量</Text>
          <Segmented
            options={COMPLEXITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            value={complexity}
            onChange={onPickComplexity}
          />
          <Text className='cedit__desc'>{COMPLEXITY_OPTIONS.find((o) => o.value === complexity)?.desc}</Text>
        </View>

        <View className='ds-footer'>
          <Button
            className='ds-btn ds-btn--primary ds-btn--block'
            hoverClass='ds-hover'
            loading={creating}
            disabled={creating || (!!workId && !workLoaded)}
            onClick={onCreate}
          >
            {creating ? (autoMode ? '创建并生成中…' : '创建中…') : autoMode && workRecipe ? '创建并生成同款' : '创建创作'}
          </Button>
        </View>
      </View>
    )
  }

  // 一键生成期间：整页占位，避免用户在半成品页面上误操作
  if (autoRunning) {
    return (
      <View className='cedit__tip'>
        <Text className='cedit__tip-main'>正在按同款配方生成文案与分镜…</Text>
        <Text className='cedit__tip-sub'>生成完成后可逐条修改，会消耗 AI 豆</Text>
      </View>
    )
  }

  if (!detail) return <View className='cedit__tip'>加载中…</View>

  const hasCopy = !!detail.copyText
  const hasShots = detail.shots.length > 0
  // 文案 → 0，分镜 → 1，素材 → 2，成片 → 3
  const step = !hasCopy ? 0 : !hasShots ? 1 : 2

  return (
    <View className='cedit'>
      <View className='cedit__steps-wrap'>
        <Steps steps={STEP_LABELS} current={step} />
        <View className='cedit__stage'>
          <Text className='cedit__stage-kicker'>STEP {step + 1} OF 4</Text>
          <Text className='cedit__stage-title'>{step === 0 ? '先把想说的话写出来' : step === 1 ? '把想法变成可执行的镜头' : '文案和分镜已经就绪，去拍摄吧'}</Text>
        </View>
      </View>

      <View className='cedit__head'>
        <Text className='cedit__htitle'>{detail.title || '未命名创作'}</Text>
        <Text className='cedit__hstore'>{detail.store?.name}</Text>
      </View>

      {/* ───────────── 口播文案：流量款 / 介绍款 / 质量款 ───────────── */}
      <View className='cedit__card'>
        <View className='cedit__secbar'>
          <Text className='cedit__sectitle'>口播文案</Text>
          <View className='cedit__secbadges'>
            {!!detail.trackLabel && <Text className='ds-pill ds-pill--red-soft'>{detail.trackLabel}</Text>}
            {hasCopy && <Text className='ds-pill ds-pill--ghost'>已生成 · {(detail.copyText ?? '').length} 字</Text>}
          </View>
        </View>

        <Segmented
          options={COPY_TRACK_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={track}
          onChange={onPickTrack}
        />
        <Text className='cedit__desc'>{COPY_TRACK_OPTIONS.find((o) => o.value === track)?.desc}</Text>

        {editingCopy ? (
          <View className='cedit__editbox'>
            <Textarea
              className='cedit__textarea'
              value={copyDraft}
              maxlength={-1}
              autoHeight
              onInput={(e: { detail: { value: string } }) => setCopyDraft(e.detail.value)}
              placeholder='编辑文案…'
              placeholderClass='cedit__ph'
            />
            <View className='cedit__acts'>
              <Button className='cedit__act cedit__act--ghost' size='mini' onClick={() => setEditingCopy(false)}>
                取消
              </Button>
              <Button className='cedit__act cedit__act--main' size='mini' onClick={onSaveCopy}>
                保存
              </Button>
            </View>
          </View>
        ) : hasCopy ? (
          <>
            <View className='cedit__copy'>{detail.copyText}</View>
            <View className='cedit__acts'>
              <Button className='cedit__act cedit__act--ghost' size='mini' onClick={() => onCopyText(detail.copyText ?? '')}>
                复制
              </Button>
              <Button className='cedit__act cedit__act--ghost' size='mini' onClick={onEditCopy}>
                编辑
              </Button>
              <Button className='cedit__act cedit__act--main' size='mini' loading={copyLoading} onClick={onGenCopy}>
                重新生成
              </Button>
            </View>
          </>
        ) : (
          <>
            <View className='cedit__empty'>选好款式后点击下方按钮生成文案</View>
            <View className='cedit__acts'>
              <Button className='cedit__act cedit__act--main' size='mini' loading={copyLoading} onClick={onGenCopy}>
                生成文案
              </Button>
            </View>
          </>
        )}
      </View>

      {/* ───────────── 分镜脚本：复杂度 → 2~9 镜，可复制/编辑/重新生成 ───────────── */}
      <View className='cedit__card'>
        <View className='cedit__secbar'>
          <Text className='cedit__sectitle'>分镜脚本（{detail.shots.length}）</Text>
          {!!detail.complexityLabel && <Text className='ds-pill ds-pill--gray'>{detail.complexityLabel}</Text>}
        </View>

        <Segmented
          options={COMPLEXITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={complexity}
          onChange={onPickComplexity}
        />
        <Text className='cedit__desc'>{COMPLEXITY_OPTIONS.find((o) => o.value === complexity)?.desc}</Text>

        <View className='cedit__genbox'>
          <Button className='cedit__act cedit__act--main' size='mini' loading={boardLoading} onClick={onGenBoard}>
            {detail.shots.length > 0 ? '重新生成' : '生成分镜'}
          </Button>
          {detail.shots.length > 0 && (
            <Button
              className='cedit__act cedit__act--ghost'
              size='mini'
              onClick={() => onCopyText(detail.shots.map(shotToText).join('\n\n'), '分镜已复制')}
            >
              一键复制
            </Button>
          )}
        </View>

        {detail.shots.length === 0 && <View className='cedit__empty'>尚未生成分镜</View>}

        {detail.shots.map((s) => (
          <View className='cedit__shot' key={s.id}>
            <View className='cedit__shothead'>
              <Text className='cedit__shotseq'>{s.seq}</Text>
              <View className='cedit__shotmeta'>
                <Text className='cedit__shottype'>{s.shotType || '未分类'}</Text>
                {!!s.shotSize && <Text className='cedit__chip'>{s.shotSize}</Text>}
                {!!s.durationSuggest && <Text className='cedit__chip'>{s.durationSuggest}s</Text>}
              </View>
              <View className='cedit__shotacts'>
                <Text className='cedit__link' onClick={() => onCopyText(shotToText(s), '已复制该分镜')}>
                  复制
                </Text>
                <Text
                  className='cedit__link'
                  onClick={() => (editingShot === s.id ? setEditingShot(null) : onStartEditShot(s))}
                >
                  {editingShot === s.id ? '收起' : '编辑'}
                </Text>
              </View>
            </View>

            {editingShot === s.id ? (
              <View className='cedit__shotedit'>
                <View className='cedit__row'>
                  <Text className='cedit__rowlabel'>镜头</Text>
                  <Picker
                    mode='selector'
                    range={SHOT_TYPES}
                    onChange={(e: { detail: { value: string | number } }) =>
                      setShotDraft((d) => ({ ...d, shotType: SHOT_TYPES[Number(e.detail.value)] ?? '' }))
                    }
                  >
                    <View className='cedit__rowvalue'>{shotDraft.shotType || '请选择'}</View>
                  </Picker>
                </View>
                <View className='cedit__row'>
                  <Text className='cedit__rowlabel'>景别</Text>
                  <Picker
                    mode='selector'
                    range={SHOT_SIZES}
                    onChange={(e: { detail: { value: string | number } }) =>
                      setShotDraft((d) => ({ ...d, shotSize: SHOT_SIZES[Number(e.detail.value)] ?? '' }))
                    }
                  >
                    <View className='cedit__rowvalue'>{shotDraft.shotSize || '请选择'}</View>
                  </Picker>
                </View>
                <View className='cedit__row'>
                  <Text className='cedit__rowlabel'>时长(s)</Text>
                  <Input
                    className='cedit__rowinput'
                    type='number'
                    value={shotDraft.durationSuggest}
                    onInput={(e: { detail: { value: string } }) =>
                      setShotDraft((d) => ({ ...d, durationSuggest: e.detail.value }))
                    }
                    placeholder='如 4'
                    placeholderClass='cedit__ph'
                  />
                </View>
                <Textarea
                  className='cedit__textarea'
                  value={shotDraft.line}
                  maxlength={-1}
                  autoHeight
                  onInput={(e: { detail: { value: string } }) => setShotDraft((d) => ({ ...d, line: e.detail.value }))}
                  placeholder='台词片段'
                  placeholderClass='cedit__ph'
                />
                <Textarea
                  className='cedit__textarea'
                  value={shotDraft.visualReq}
                  maxlength={-1}
                  autoHeight
                  onInput={(e: { detail: { value: string } }) => setShotDraft((d) => ({ ...d, visualReq: e.detail.value }))}
                  placeholder='画面要求'
                  placeholderClass='cedit__ph'
                />
                <View className='cedit__acts'>
                  <Button className='cedit__act cedit__act--ghost' size='mini' onClick={() => setEditingShot(null)}>
                    取消
                  </Button>
                  <Button className='cedit__act cedit__act--main' size='mini' onClick={() => onSaveShot(s.id)}>
                    保存
                  </Button>
                </View>
              </View>
            ) : (
              <View className='cedit__shotbody'>
                <Text className='cedit__shotline'>{s.line || '—'}</Text>
                {!!s.visualReq && <Text className='cedit__shotvisual'>画面：{s.visualReq}</Text>}
                {!!s.libraryShot?.name && <Text className='cedit__shotlib'>手法：{s.libraryShot.name}</Text>}
              </View>
            )}
          </View>
        ))}
      </View>

      <View className='ds-footer'>
        <Button
          className={`ds-btn ds-btn--primary ds-btn--block ${detail.shots.length === 0 ? 'ds-btn--disabled' : ''}`}
          hoverClass='ds-hover'
          disabled={detail.shots.length === 0}
          onClick={() => Taro.navigateTo({ url: `/pages/creation/shots?id=${localId}` })}
        >
          下一步 · 拍摄上传素材
        </Button>
        <View className='ds-footer__note'>
          {detail.shots.length === 0 ? '先生成分镜后再拍摄素材' : '文案与分镜已保存，可随时回来修改'}
        </View>
      </View>
    </View>
  )
}
