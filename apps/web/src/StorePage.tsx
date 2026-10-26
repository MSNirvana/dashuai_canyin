import { useEffect, useState, type FormEvent } from 'react'
import { WsPage, Field, useMyStore } from './workspace-ui'
import { createStore, updateStore, type StoreInput } from './workspace-data'

const EMPTY: StoreInput = { name: '', category: '', city: '', district: '', address: '', intro: '' }

/**
 * 门店资料。
 *
 * ★ 这里的字段会直接进 AI 提示词的「门店信息」区块，所以要写得像跟自己人说话：
 *   品类写「川菜」不如写「主打干锅和凉菜的川味小馆」——后者模型才知道该用什么语感。
 *   页面上那句话是给用户看的，不是装饰。
 */
export function StorePage() {
  const { store, loading, error, reload } = useMyStore()
  const [form, setForm] = useState<StoreInput>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (!store) return
    setForm({
      name: store.name ?? '',
      category: store.category ?? '',
      city: store.city ?? '',
      district: store.district ?? '',
      address: store.address ?? '',
      intro: store.intro ?? '',
    })
  }, [store])

  const set = <K extends keyof StoreInput>(key: K, value: StoreInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!form.name.trim()) {
      setNotice({ ok: false, text: '门店名称不能为空' })
      return
    }
    setSaving(true)
    setNotice(null)
    try {
      if (store) await updateStore(store.id, form)
      else await createStore(form)
      await reload()
      setNotice({ ok: true, text: store ? '已保存' : '门店已创建' })
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '保存失败，请稍后再试' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <WsPage
      title="门店信息"
      lead="一个账号对应一家门店。这里的名字、品类和介绍会被 AI 读进提示词，写文案时用来交代「这是谁家的店」。"
    >
      {loading && <p className="loading-block">正在读取门店…</p>}
      {error && <p className="action-error">{error}</p>}

      {!loading && !error && (
        <form className="ws-form" onSubmit={submit}>
          <Field label="门店名称" hint="写客人认得出的名字，比如「老陈干锅」；不要写公司全称。">
            <input
              className="ws-input"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="如：老陈干锅"
              maxLength={128}
            />
          </Field>

          <div className="ws-row">
            <Field label="品类" hint="越具体越好。">
              <input
                className="ws-input"
                value={form.category}
                onChange={(e) => set('category', e.target.value)}
                placeholder="如：干锅 · 川味小馆"
                maxLength={64}
              />
            </Field>
            <Field label="城市">
              <input
                className="ws-input"
                value={form.city}
                onChange={(e) => set('city', e.target.value)}
                placeholder="如：廊坊"
                maxLength={64}
              />
            </Field>
          </div>

          <div className="ws-row">
            <Field label="区 / 县">
              <input
                className="ws-input"
                value={form.district}
                onChange={(e) => set('district', e.target.value)}
                placeholder="选填"
                maxLength={64}
              />
            </Field>
            <Field label="详细地址">
              <input
                className="ws-input"
                value={form.address}
                onChange={(e) => set('address', e.target.value)}
                placeholder="选填，写到门牌号"
                maxLength={255}
              />
            </Field>
          </div>

          <Field
            label="一句话介绍"
            hint="写清「做什么、给谁做、凭什么」。AI 会把它揉进开场那句，但不会原样念出来。"
          >
            <textarea
              className="ws-textarea"
              value={form.intro}
              onChange={(e) => set('intro', e.target.value)}
              placeholder="如：开了九年的小馆子，专做现炒干锅，主打一个锅气足、量给够，中午多是附近上班的熟客。"
              rows={4}
              maxLength={500}
            />
          </Field>

          {notice && (
            <p className={notice.ok ? 'ws-ok' : 'action-error'}>{notice.text}</p>
          )}

          <div className="ws-actions">
            <button className="button" type="submit" disabled={saving}>
              {saving ? '保存中…' : store ? '保存门店资料' : '创建门店'}
            </button>
          </div>
        </form>
      )}
    </WsPage>
  )
}
