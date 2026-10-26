import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { WsPage, useMyStore } from './workspace-ui'
import { getPersona, listDishes } from './workspace-data'

/**
 * 工作台概览。
 *
 * ★ 只回答两个问题：「资料凑齐了没有」「下一步点哪里」。
 *   不做数据看板（成片数量、消耗曲线那些）—— 这块还没有真实数据源，
 *   先把「能让 AI 认得你家店」的三件事（门店 / 菜品 / 人设）串起来。
 */
export function Workspace() {
  const { store, loading, error } = useMyStore()
  const [dishCount, setDishCount] = useState<number | null>(null)
  const [personaReady, setPersonaReady] = useState<boolean | null>(null)

  useEffect(() => {
    if (!store) return
    let alive = true
    void (async () => {
      try {
        const [dishes, persona] = await Promise.all([listDishes(store.id), getPersona(store.id)])
        if (!alive) return
        setDishCount(dishes.length)
        setPersonaReady(Boolean(persona.bossTags?.trim() || persona.activity?.trim()))
      } catch {
        if (alive) {
          setDishCount(null)
          setPersonaReady(null)
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [store])

  const readyCount = [Boolean(store), (dishCount ?? 0) > 0, Boolean(personaReady)].filter(Boolean).length

  return (
    <WsPage
      title="工作台"
      lead="门店资料、菜品、老板人设都放在这里。AI 写文案时会先读这些内容 —— 填得越具体，写出来越像你家店说的话。"
    >
      {loading && <p className="loading-block">正在读取门店…</p>}
      {error && <p className="action-error">{error}</p>}

      {!loading && !error && !store && (
        <div className="empty-state">
          <div className="empty-icon">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 9h16M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9M4 9l2-4h12l2 4" />
              <path d="M9 13h6" />
            </svg>
          </div>
          <h3>先建一家门店</h3>
          <p>一个账号对应一家门店。填好名字和所在城市，后面的菜品、文案、成片都会挂在这家店下面。</p>
          <Link className="button" to="/app/store">去填写门店资料</Link>
        </div>
      )}

      {store && (
        <>
          <section className="ws-summary">
            <div>
              <p className="ws-summary-label">当前门店</p>
              <h2>{store.name}</h2>
              <p className="ws-summary-meta">
                {[store.city, store.district].filter(Boolean).join(' · ') || '还没填所在城市'}
                {store.category ? ` · ${store.category}` : ''}
              </p>
            </div>
            <div className="ws-progress">
              <span className="ws-progress-num">{readyCount}/3</span>
              <span className="ws-progress-label">资料就绪</span>
            </div>
          </section>

          <div className="ws-grid">
            <Link className="ws-card" to="/app/store">
              <h3>门店信息</h3>
              <p>店名、品类、地址、一句话介绍。这段介绍会直接进文案开场。</p>
              <span className="ws-card-state ok">已填写</span>
            </Link>

            <Link className="ws-card" to="/app/dishes">
              <h3>菜品库</h3>
              <p>每道菜记下卖点、做法、价格。选菜之后 AI 只讲这道菜。</p>
              <span className={`ws-card-state${(dishCount ?? 0) > 0 ? ' ok' : ''}`}>
                {dishCount === null ? '待读取' : dishCount > 0 ? `${dishCount} 道菜` : '还没添加'}
              </span>
            </Link>

            <Link className="ws-card" to="/app/persona">
              <h3>老板人设</h3>
              <p>你平时怎么做事、有什么讲究。写进去，文案才会带上你的口气。</p>
              <span className={`ws-card-state${personaReady ? ' ok' : ''}`}>
                {personaReady === null ? '待读取' : personaReady ? '已填写' : '还没填写'}
              </span>
            </Link>
          </div>

          <section className="ws-note">
            <h3>{readyCount === 3 ? '三样都齐了，去写第一条' : '这三样凑齐之后'}</h3>
            <p>
              {readyCount === 3
                ? '选一道招牌菜，AI 会按你上面填的门店、菜品和口气写文案，再拆成能照着拍的分镜。'
                : '就可以让 AI 按你选的菜和款式写口播文案、拆分镜脚本。缺哪一样，写出来的话就少一层依据。'}
            </p>
            {/* 只给一个去向：下面那排标签里已经有「创作」，再放一条「看我的创作」是同一个目的地的两个入口 */}
            <div className="ws-actions ws-actions-inline" style={{ marginTop: 14 }}>
              <Link className="button small" to="/app/creations/new">写第一条文案</Link>
            </div>
          </section>
        </>
      )}
    </WsPage>
  )
}
