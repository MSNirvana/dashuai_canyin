// 流量款 · 跟热点 —— 话题驱动的独立功能。
//
// 为什么单独一页，而不是在创作页加一款：
//   创作页整页都在讲「选门店、选菜品、选款式」，而这一款的**输入完全不同** ——
//   没有门店、没有菜品，只有「今天是什么日子」。把它塞进创作页会得到一条
//   既不提门店也不提菜品的稿子，用户只会以为是 AI 坏了（而且不报错）。
//   拆成独立入口后，两条链路各自闭环：这条出稿 → 拍摄 → 合成，产物仍是同一个 creation。
//
// ★ 页面上**不出现**门店与菜品：宿主门店由服务端自己挑（只为媒体归属与下游合成）。
//   ★ 用户在这一页唯一需要决定的东西只有「镜头复杂度」—— 地域钩子（文案里会不会出现
//   「咱XX的」）由服务端直接从门店档案的位置取，用户不用手填；门店没填位置就不带这个信息。
//   2026-09-21 之前这里有个「同城落点（选填）」输入框，已按用户要求整块删掉
//   （原话：「同城落地不需要，直接获取店铺位置就行了，没有填写位置就不要这个信息」）。
import { useCallback, useRef, useState } from 'react'
import { View, Text } from '@tarojs/components'
import Taro, { useDidShow, useRouter } from '@tarojs/taro'
import {
  createCreation,
  generateCopy,
  generateStoryboard,
  getCreation,
  updateCreation,
  COMPLEXITY_OPTIONS,
  type Complexity,
  type CreationDetail,
  type ShotItem,
} from '../../services/creation'
import Segmented from '../../components/segmented'
import { splitCopyParagraphs, copyTextParagraphs } from '../../utils/copy-text'
import { readRouteId, isBrokenRouteId } from '../../utils/route-id'
import './traffic.scss'

function newRequestId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** 把分镜整批拼成可复制的文本（与拍摄页同一口径：台词 + 怎么拍） */
function shotsToText(shots: ShotItem[]) {
  return shots
    .map((s) => {
      const head = `${s.seq}. 【${s.shotType ?? ''}·${s.shotSize ?? ''}】${s.durationSuggest ?? ''}s`
      return [head, `台词：${s.line ?? ''}`, `怎么拍：${s.visualReq ?? ''}`].join('\n')
    })
    .join('\n\n')
}

export default function CreationTraffic() {
  const router = useRouter()
  const [routeId] = useState(() => readRouteId(router.params))
  const brokenId = isBrokenRouteId(router.params)

  const [complexity, setComplexity] = useState<Complexity>('COMPLEX')
  const [detail, setDetail] = useState<CreationDetail | null>(null)
  const [busy, setBusy] = useState(false)
  /** 当前正在做的一步，用于按钮文案（生成要走 15~90 秒，必须让用户知道在等什么） */
  const [step, setStep] = useState('')
  const [err, setErr] = useState<string | null>(null)
  /** 生成期间的「退出点」：离开页面后不再自动跳转，但请求照常跑完落库 */
  const leavingRef = useRef(false)
  /**
   * 本页「正在用的那条创作」的 id。
   *
   * ★ 为什么必须有它（2026-09-21 实测缺陷）：从创作页的「流量款」卡片进来时
   *   `navigateTo('/pages/creation/traffic')` **不带参数** ⇒ `routeId` 恒为空串
   *   （`useState` 只在挂载时读一次路由参数，之后不会再变）。
   *   而本页唯一的自动刷新点 `useDidShow` 以前只认 `routeId` ⇒ 生成中途离开再回来时
   *   **永远不补拉**：分镜在服务端已经生成成功、也已经落库，页面却停在「还没有分镜」。
   *   实测现场：生成耗时 259 秒，用户等不及离开，回来看到的就是空分镜
   *   （nginx 日志里分镜返回之后再无 `GET /creations/:id`，与「routeId 为空不补拉」吻合）。
   */
  const activeIdRef = useRef('')

  const load = useCallback(async (id: string) => {
    try {
      const d = await getCreation(id)
      setDetail(d)
      const c = d.complexity
      if (c === 'SIMPLE' || c === 'COMPLEX' || c === 'FINE') setComplexity(c)
      // 地域钩子（d.topicCity）不回填到界面上 —— 它已经不是一个可编辑的输入了
    } catch (e) {
      setErr((e as { message?: string })?.message ?? '加载失败')
    }
  }, [])

  useDidShow(() => {
    leavingRef.current = false
    // ★ 用「本页正在用的 id」兜底：新建的话题稿没有 routeId（入口不带参数），
    //   只看 routeId 会让「生成成功但页面拿不到」永久无法自愈。
    const id = routeId || activeIdRef.current
    if (id) void load(id)
  })

  /** 生成：新建 → 落库 → 出文案 → 出分镜。任一步失败都停在本页并说清断在哪一步 */
  const onGenerate = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    leavingRef.current = false
    let stepName = '创建'
    try {
      let id = detail?.id ?? routeId ?? ''
      if (!id) {
        stepName = '创建'
        setStep('正在准备…')
        const created = await createCreation({ mode: 'TOPIC', complexity })
        id = created.id
        setDetail(created)
      } else {
        // 已有创作：把页面上的改动落库（只有复杂度）。不扣积分。
        // 服务端会顺手给老稿子补上地域快照（见 creation.service 的 updateCreation）。
        stepName = '保存设置'
        const updated = await updateCreation(id, { complexity })
        setDetail(updated)
      }
      // ★ 记下本页正在用的稿子：新建的稿子没有 routeId，之后 `useDidShow` 的
      //   补拉只能靠它，否则「生成成功但页面拿不到」无法自愈。
      activeIdRef.current = id

      stepName = '文案'
      setStep('正在想今天的话题…')
      const copy = await generateCopy(id, newRequestId())
      // 走完文案就可能被「离开」：请求撤不回来，结果会落库，用户稍后进来接着用
      if (leavingRef.current) return

      stepName = '分镜'
      setStep('正在排分镜…')
      const board = await generateStoryboard(id, newRequestId(), complexity)

      // ★★ 生成成果必须无条件回填 —— **不能**因为「用户中途离开过」就先 return。
      //
      //   反面教材（2026-09-21 实测）：原先这里先 `if (leavingRef.current) return`
      //   再拉取，于是用户等分镜等不及（实测 259 秒）离开后，分镜虽然已在服务端
      //   生成成功、也已经落库，但**页面与 nginx 日志里都看不到任何补拉请求**
      //   （分镜返回后再无 `GET /creations/:id`）；再回到本页时 `routeId` 为空、
      //   `useDidShow` 也不补拉 ⇒ 用户看到的是「还没有分镜」，
      //   等于白等一次、白扣一次积分。分镜是这条链上最慢最贵的一步，
      //   它的结果必须无条件落回页面；「离开过」只该影响要不要再弹提示。
      const fresh = await getCreation(id)
      setDetail(fresh)
      if (leavingRef.current) return

      if (!board.parsed || board.shots.length === 0) {
        // 没有分镜就没法拍摄，停在本页让用户重试，别把他送进一个空的拍摄列表
        setErr('分镜没解析出来，点「重新生成」再试一次')
      } else if (copy.isFallbackTemplate || board.isFallbackTemplate) {
        Taro.showToast({ title: 'AI 繁忙，这次用了兜底内容', icon: 'none', duration: 2500 })
      }
    } catch (e) {
      const msg = (e as { message?: string })?.message ?? '生成失败，请重试'
      // 断在哪一步要说出来：三步共用一句话，用户不知道是重试还是该去建门店
      setErr(stepName === '创建' || stepName === '保存设置' ? msg : `${stepName}没生成出来：${msg}`)
    } finally {
      setBusy(false)
      setStep('')
    }
  }

  const onCopy = (text: string, label: string) => {
    if (!text.trim()) return Taro.showToast({ title: '暂无可复制内容', icon: 'none' })
    Taro.setClipboardData({ data: text })
      .then(() => Taro.showToast({ title: label, icon: 'none' }))
      .catch(() => undefined)
  }

  const onGoShoot = () => {
    const id = detail?.id
    if (!id) return Taro.showToast({ title: '先生成一次', icon: 'none' })
    leavingRef.current = true
    Taro.navigateTo({ url: `/pages/creation/shots?id=${id}` })
  }

  const copyText = detail?.copyText ?? ''
  const paragraphs = splitCopyParagraphs(copyText)
  const shots = detail?.shots ?? []
  const complexityDesc = COMPLEXITY_OPTIONS.find((o) => o.value === complexity)?.desc ?? ''

  // 编号丢了：说清「从哪进」而不是把 'undefined' 拼进接口再展示服务端的参数报错
  if (brokenId && !routeId) {
    return (
      <View className='ctraffic'>
        <View className='ctraffic__card'>
          <Text className='ctraffic__hint'>编号丢了。请回到「创作」列表，从那条话题稿重新进入。</Text>
        </View>
      </View>
    )
  }

  return (
    <View className='ctraffic'>
      <View className='ctraffic__hero'>
        <Text className='ctraffic__hero-title'>流量款 · 跟热点</Text>
        <Text className='ctraffic__hero-desc'>
          跟着今天的话题、节气、节日出稿，拍完就能发。
        </Text>
      </View>

      {/* 镜头复杂度：话题稿唯一需要用户决定的参数 */}
      <View className='ctraffic__card'>
        <Text className='ctraffic__label'>镜头复杂度</Text>
        <Segmented
          options={COMPLEXITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          value={complexity}
          onChange={(v) => setComplexity(v as Complexity)}
        />
        <Text className='ctraffic__hint'>{complexityDesc}</Text>
      </View>

      <View
        className={`ctraffic__btn ${busy ? 'ctraffic__btn--busy' : ''}`}
        hoverClass={busy ? 'none' : 'ds-hover'}
        onClick={() => void onGenerate()}
      >
        {busy ? step || '生成中…' : copyText ? '重新生成' : '生成'}
      </View>

      {!!err && (
        <View className='ctraffic__err'>
          <Text className='ctraffic__err-text'>{err}</Text>
        </View>
      )}

      {/* ── 文案 ── */}
      <View className='ctraffic__card'>
        <View className='ctraffic__head'>
          <Text className='ctraffic__label'>口播文案</Text>
          {!!copyText && (
            <Text className='ctraffic__act' onClick={() => onCopy(copyTextParagraphs(copyText), '文案已复制')}>
              复制
            </Text>
          )}
        </View>
        {paragraphs.length === 0 ? (
          <Text className='ctraffic__empty'>{busy ? '正在生成…' : '还没有文案，点上面的按钮生成'}</Text>
        ) : (
          paragraphs.map((p, i) => (
            <Text className='ctraffic__copy' key={i}>
              {p}
            </Text>
          ))
        )}
      </View>

      {/* ── 分镜 ── */}
      <View className='ctraffic__card'>
        <View className='ctraffic__head'>
          <Text className='ctraffic__label'>分镜脚本{shots.length > 0 ? ` · ${shots.length} 镜` : ''}</Text>
          {shots.length > 0 && (
            <Text className='ctraffic__act' onClick={() => onCopy(shotsToText(shots), '分镜已复制')}>
              复制
            </Text>
          )}
        </View>
        {shots.length === 0 ? (
          <Text className='ctraffic__empty'>{busy ? '正在生成…' : '还没有分镜'}</Text>
        ) : (
          shots.map((s) => (
            <View className='ctraffic__shot' key={s.id}>
              <View className='ctraffic__shot-head'>
                <Text className='ctraffic__shot-seq'>{s.seq}</Text>
                <Text className='ctraffic__shot-tag'>{s.shotType ?? ''}</Text>
                <Text className='ctraffic__shot-tag'>{s.shotSize ?? ''}</Text>
                {s.durationSuggest !== null && <Text className='ctraffic__shot-dur'>{s.durationSuggest}s</Text>}
              </View>
              <Text className='ctraffic__shot-line'>{s.line ?? ''}</Text>
              <Text className='ctraffic__shot-visual'>{s.visualReq ?? ''}</Text>
            </View>
          ))
        )}
      </View>

      {shots.length > 0 && (
        <View className='ctraffic__btn ctraffic__btn--ghost' hoverClass='ds-hover' onClick={onGoShoot}>
          去拍摄
        </View>
      )}
    </View>
  )
}
