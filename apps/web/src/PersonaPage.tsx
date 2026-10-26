import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { WsPage, Field, useMyStore } from './workspace-ui'
import { getPersona, savePersona } from './workspace-data'

/**
 * 老板人设。
 *
 * ★ 这一页决定文案「像不像你说的话」。空着的时候 AI 只能写通用口播；
 *   填了之后它会把「我怎么做事」揉进句子，但**不会编造经历**（提示词里有明确禁令）。
 * ★ 所以提示语强调「只写你真做过的事」，而不是「写得有文采」。
 */
export function PersonaPage() {
  const { store, loading, error } = useMyStore()
  const [bossTags, setBossTags] = useState('')
  const [activity, setActivity] = useState('')
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  const storeId = store?.id ?? null

  useEffect(() => {
    if (!storeId) return
    void (async () => {
      try {
        const persona = await getPersona(storeId)
        setBossTags(persona.bossTags ?? '')
        setActivity(persona.activity ?? '')
      } catch {
        /* 首次没有记录时服务端返回空壳，这里不必打扰用户 */
      }
    })()
  }, [storeId])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!storeId) return
    setSaving(true)
    setNotice(null)
    try {
      await savePersona(storeId, {
        bossTags: bossTags.trim() || null,
        activity: activity.trim() || null,
      })
      setNotice({ ok: true, text: '已保存' })
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '保存失败，请稍后再试' })
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <WsPage title="老板人设"><p className="loading-block">正在读取门店…</p></WsPage>

  if (!store) {
    return (
      <WsPage title="老板人设" lead="人设挂在门店下面，先把门店建好。">
        <div className="empty-state">
          <h3>还没有门店</h3>
          <p>先填写门店资料，再来写人设。</p>
          <Link className="button" to="/app/store">去填写门店资料</Link>
        </div>
      </WsPage>
    )
  }

  return (
    <WsPage
      title="老板人设"
      lead="这里只写你真做过的事、真有的讲究。AI 会照着这个口气说话，但不会替你编经历 —— 写实的部分它才敢用。"
    >
      {error && <p className="action-error">{error}</p>}

      <form className="ws-form" onSubmit={submit}>
        <Field
          label="你是个什么样的老板"
          hint="短句、口语。比如「不爱说漂亮话」「宁可慢一点也要现炒」。"
        >
          <textarea
            className="ws-textarea"
            value={bossTags}
            onChange={(e) => setBossTags(e.target.value)}
            placeholder="如：做菜三十年的老陈，脾气直，不爱说漂亮话，但客人说菜不对会自己重做一份。"
            rows={4}
            maxLength={500}
          />
        </Field>

        <Field
          label="平时怎么做事"
          hint="越具体越好：几点去进货、怎么挑、什么环节不肯省。这些细节是文案里最有说服力的部分。"
        >
          <textarea
            className="ws-textarea"
            value={activity}
            onChange={(e) => setActivity(e.target.value)}
            placeholder="如：每天早上六点自己去市场挑货，鸭头只要当天的；干锅底料自己炒，一次炒三天的量，卖完就收。"
            rows={5}
            maxLength={1000}
          />
        </Field>

        {notice && <p className={notice.ok ? 'ws-ok' : 'action-error'}>{notice.text}</p>}

        <div className="ws-actions">
          <button className="button" type="submit" disabled={saving}>
            {saving ? '保存中…' : '保存人设'}
          </button>
        </div>
      </form>
    </WsPage>
  )
}
