import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { WsPage, Field, useMyStore } from './workspace-ui'
import { listDishes, type Dish } from './workspace-data'
import {
  COMPLEXITY_OPTIONS,
  COPY_TRACK_OPTIONS,
  STYLE_TRACK_OPTIONS,
  createCreation,
  type Complexity,
  type ContentMode,
  type CopyTrack,
} from './creations-data'

const MODES: { value: ContentMode; label: string; desc: string }[] = [
  { value: 'DISH', label: '菜品稿', desc: '讲一道菜：有什么、怎么做、多少钱' },
  { value: 'TOPIC', label: '话题稿', desc: '跟节气、节日、时令话题，不提自家店名' },
  { value: 'STYLE', label: '款式稿', desc: '不给菜品资料，只按款式写' },
]

/**
 * 新建创作。
 *
 * ★ 三种模式的必填项**由服务端一处判定**，这里只负责把界面收拾干净（不给用户制造必然报错的组合）：
 *   · 菜品稿：门店必填、菜品可选（不选 = 只讲门店）
 *   · 话题稿：门店与菜品**都不传**（服务端会报 2002），地域钩子由门店档案自动取
 *   · 款式稿：门店必填、菜品不许传、款式只有人设型与知识型
 * ★ 所以切模式时要把残留的选择清掉 —— 否则用户先选菜再切「款式稿」，
 *   提交后拿到一个 2015 报错，而他根本没看懂自己做错了什么。
 */
export function CreationNewPage() {
  const navigate = useNavigate()
  const { store, loading } = useMyStore()
  const [dishes, setDishes] = useState<Dish[]>([])
  const [mode, setMode] = useState<ContentMode>('DISH')
  const [dishId, setDishId] = useState('')
  const [track, setTrack] = useState<CopyTrack>('PRODUCT')
  const [complexity, setComplexity] = useState<Complexity>('COMPLEX')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!store) return
    void (async () => {
      try {
        setDishes(await listDishes(store.id))
      } catch {
        /* 菜品读不到不该挡住创建：菜品是可选项 */
      }
    })()
  }, [store])

  // 切模式时清掉不属于该模式的残留选择（见上面注释）
  const switchMode = (next: ContentMode) => {
    setMode(next)
    setError(null)
    if (next !== 'DISH') setDishId('')
    if (next === 'STYLE' && (track === 'PRODUCT' || track === 'RECOMMEND')) setTrack('PERSONA')
    if (next === 'DISH' && (track === 'PERSONA' || track === 'KNOWLEDGE')) setTrack('PRODUCT')
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (mode !== 'TOPIC' && !store) {
      setError('这条创作要挂在门店下面，请先填写门店资料')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const created = await createCreation({
        mode,
        storeId: mode === 'TOPIC' ? undefined : store?.id,
        dishId: mode === 'DISH' && dishId ? dishId : undefined,
        track,
        complexity,
      })
      navigate(`/app/creations/${created.id}`, { replace: true })
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败，请稍后再试')
    } finally {
      setSaving(false)
    }
  }

  const trackOptions = mode === 'STYLE' ? STYLE_TRACK_OPTIONS : COPY_TRACK_OPTIONS

  if (loading) return <WsPage title="新建创作"><p className="loading-block">正在读取门店…</p></WsPage>

  return (
    <WsPage title="新建创作" lead="先定「讲什么」和「用哪种口吻」，文案生成后还能改。">
      <form className="ws-form" onSubmit={submit}>
        <Field label="写哪种" hint="三种模式的资料要求不同，选错了会拿到报错，所以先定这个。">
          <div className="ws-chips">
            {MODES.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={mode === item.value}
                className={`ws-chip${mode === item.value ? ' active' : ''}`}
                onClick={() => switchMode(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="ws-hint">{MODES.find((m) => m.value === mode)?.desc}</p>
        </Field>

        {mode === 'DISH' && (
          <Field label="讲哪道菜" hint="不选也可以：那样只讲门店本身。">
            <select className="ws-input" value={dishId} onChange={(e) => setDishId(e.target.value)}>
              <option value="">不选菜品，只讲门店</option>
              {dishes.map((dish) => (
                <option key={dish.id} value={dish.id}>{dish.name}</option>
              ))}
            </select>
          </Field>
        )}

        {mode === 'TOPIC' && (
          <p className="ws-note-inline">
            话题稿不提门店也不提菜品，只靠节气、节日和时令找话题。门店没填所在城市也能用，填了会带上同城的落点。
          </p>
        )}

        <Field label="用哪种口吻" hint="这一项决定文案的写法，不是字数。">
          <div className="ws-chips">
            {trackOptions.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={track === item.value}
                className={`ws-chip${track === item.value ? ' active' : ''}`}
                onClick={() => setTrack(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="ws-hint">{trackOptions.find((t) => t.value === track)?.desc}</p>
        </Field>

        <Field label="多长" hint="分镜数量与口播长度一起变，后面还能改。">
          <div className="ws-chips">
            {COMPLEXITY_OPTIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={complexity === item.value}
                className={`ws-chip${complexity === item.value ? ' active' : ''}`}
                onClick={() => setComplexity(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <p className="ws-hint">{COMPLEXITY_OPTIONS.find((c) => c.value === complexity)?.desc}</p>
        </Field>

        {error && <p className="action-error">{error}</p>}

        <div className="ws-actions">
          <button className="button" type="submit" disabled={saving}>
            {saving ? '创建中…' : '创建，去写文案'}
          </button>
          <Link className="button secondary" to="/app/creations">取消</Link>
        </div>
      </form>
    </WsPage>
  )
}
