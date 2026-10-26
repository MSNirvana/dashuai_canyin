import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { WsPage, Field, useMyStore } from './workspace-ui'
import {
  createDish,
  deleteDish,
  fenToYuanText,
  formatFen,
  listDishes,
  parseYuanToFen,
  updateDish,
  type Dish,
} from './workspace-data'

interface DishForm {
  name: string
  price: string
  originalPrice: string
  sellingPoints: string
  intro: string
}

const EMPTY: DishForm = { name: '', price: '', originalPrice: '', sellingPoints: '', intro: '' }

/**
 * 菜品库。
 *
 * ★ 卖点那一栏是生成质量的杠杆：写「好吃、香」等于没写，写成
 *   「鸭头先卤后炒，出锅前撒一把孜然」模型才知道该讲什么。
 * ★ 价格只用于「产品型」文案里报真价；不填就不报价（不是 0 元）。
 */
export function DishesPage() {
  const { store, loading, error } = useMyStore()
  const [dishes, setDishes] = useState<Dish[]>([])
  const [listLoading, setListLoading] = useState(false)
  const [editingId, setEditingId] = useState<string | 'new' | null>(null)
  const [form, setForm] = useState<DishForm>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const storeId = store?.id ?? null

  const load = useCallback(async () => {
    if (!storeId) return
    setListLoading(true)
    try {
      setDishes(await listDishes(storeId))
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '菜品加载失败' })
    } finally {
      setListLoading(false)
    }
  }, [storeId])

  useEffect(() => {
    void load()
  }, [load])

  const startNew = () => {
    setEditingId('new')
    setForm(EMPTY)
    setNotice(null)
  }

  const startEdit = (dish: Dish) => {
    setEditingId(dish.id)
    setForm({
      name: dish.name,
      price: fenToYuanText(dish.priceFen),
      originalPrice: fenToYuanText(dish.originalPriceFen),
      sellingPoints: dish.sellingPoints ?? '',
      intro: dish.intro ?? '',
    })
    setNotice(null)
  }

  const cancel = () => {
    setEditingId(null)
    setNotice(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!storeId) return
    if (!form.name.trim()) {
      setNotice({ ok: false, text: '菜名不能为空' })
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      const body = {
        name: form.name.trim(),
        intro: form.intro,
        sellingPoints: form.sellingPoints,
        priceFen: parseYuanToFen(form.price),
        // null = 显式清空划线价；不传 = 沿用库里的，所以这里有值传值、空串传 null
        originalPriceFen: form.originalPrice.trim() ? parseYuanToFen(form.originalPrice) ?? null : null,
      }
      if (editingId === 'new') await createDish(storeId, body)
      else if (editingId) await updateDish(storeId, editingId, body)
      await load()
      setEditingId(null)
      setNotice({ ok: true, text: '已保存' })
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '保存失败，请稍后再试' })
    } finally {
      setSaving(false)
    }
  }

  const remove = async (dish: Dish) => {
    if (!storeId) return
    if (!window.confirm(`删除「${dish.name}」？已经生成的文案不会受影响，但这个菜会从库里消失。`)) return
    try {
      await deleteDish(storeId, dish.id)
      await load()
      setNotice({ ok: true, text: '已删除' })
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '删除失败' })
    }
  }

  if (loading) return <WsPage title="菜品库"><p className="loading-block">正在读取门店…</p></WsPage>

  if (!store) {
    return (
      <WsPage title="菜品库" lead="菜品要挂在门店下面，所以先把门店建好。">
        <div className="empty-state">
          <h3>还没有门店</h3>
          <p>先填写门店资料，再回来添加菜品。</p>
          <Link className="button" to="/app/store">去填写门店资料</Link>
        </div>
      </WsPage>
    )
  }

  return (
    <WsPage
      title="菜品库"
      lead="每道菜记下卖点、做法和价格。写文案时选了哪道菜，AI 就只讲这道菜，不会泛泛而谈。"
    >
      {error && <p className="action-error">{error}</p>}

      {editingId === null && (
        <div className="ws-toolbar">
          <p className="ws-count">
            {listLoading ? '正在加载…' : `共 ${dishes.length} 道菜`}
          </p>
          <button className="button small" type="button" onClick={startNew}>添加菜品</button>
        </div>
      )}

      {notice && <p className={notice.ok ? 'ws-ok' : 'action-error'}>{notice.text}</p>}

      {editingId !== null && (
        <form className="ws-form ws-form-inline" onSubmit={submit}>
          <h3>{editingId === 'new' ? '添加菜品' : '编辑菜品'}</h3>

          <Field label="菜名" hint="写菜单上的叫法。">
            <input
              className="ws-input"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="如：干锅鸭头"
              maxLength={128}
            />
          </Field>

          <div className="ws-row">
            <Field label="售价（元）" hint="不填就不在文案里报价。">
              <input
                className="ws-input"
                value={form.price}
                onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                placeholder="如：68"
                inputMode="decimal"
              />
            </Field>
            <Field label="划线价（元）">
              <input
                className="ws-input"
                value={form.originalPrice}
                onChange={(e) => setForm((f) => ({ ...f, originalPrice: e.target.value }))}
                placeholder="选填"
                inputMode="decimal"
              />
            </Field>
          </div>

          <Field
            label="卖点"
            hint="写具体的动作和细节。「卤足两小时、出锅撒孜然」比「香辣入味」有用得多。多条用顿号或换行分开。"
          >
            <textarea
              className="ws-textarea"
              value={form.sellingPoints}
              onChange={(e) => setForm((f) => ({ ...f, sellingPoints: e.target.value }))}
              placeholder="如：鸭头先卤后炒、锅气足、配菜给得实在"
              rows={3}
              maxLength={1000}
            />
          </Field>

          <Field label="补充说明" hint="选填。适合放来历、吃法、适合几个人吃这类背景。">
            <textarea
              className="ws-textarea"
              value={form.intro}
              onChange={(e) => setForm((f) => ({ ...f, intro: e.target.value }))}
              rows={3}
              maxLength={500}
            />
          </Field>

          <div className="ws-actions">
            <button className="button" type="submit" disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button className="button secondary" type="button" onClick={cancel} disabled={saving}>取消</button>
          </div>
        </form>
      )}

      {editingId === null && dishes.length === 0 && !listLoading && (
        <div className="empty-state">
          <div className="empty-icon">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="8" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </div>
          <h3>还没有菜品</h3>
          <p>先加两三道招牌菜。有了菜，AI 才知道该讲哪一口。</p>
          <button className="button" type="button" onClick={startNew}>添加第一道菜</button>
        </div>
      )}

      {editingId === null && dishes.length > 0 && (
        <ul className="ws-list">
          {dishes.map((dish) => (
            <li className="ws-list-item" key={dish.id}>
              <div className="ws-list-main">
                <h3>{dish.name}</h3>
                <p className="ws-list-meta">
                  {formatFen(dish.priceFen)}
                  {dish.originalPriceFen ? <s>{formatFen(dish.originalPriceFen)}</s> : null}
                  {dish.kind === 'COMBO' ? <span className="ws-tag">套餐</span> : null}
                </p>
                {dish.sellingPoints && <p className="ws-list-desc">{dish.sellingPoints}</p>}
              </div>
              <div className="ws-list-actions">
                {/* ★ 用 ghost（白底细描边，本页由 .ws-list-actions 改灰底）而不是
                    secondary（浅红底）：列表里每行都有「编辑」，配上顶部那颗红实心的
                    「添加菜品」，一屏会出现 3 个红色按钮 —— 主行动就不再是唯一的了。 */}
                <button className="button small ghost" type="button" onClick={() => startEdit(dish)}>编辑</button>
                <button className="icon-text-button" type="button" onClick={() => void remove(dish)}>删除</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </WsPage>
  )
}
