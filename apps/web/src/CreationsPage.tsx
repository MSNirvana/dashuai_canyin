import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { WsPage } from './workspace-ui'
import {
  formatCreationTime,
  listCreations,
  progressOf,
  type CreationItem,
} from './creations-data'

type Filter = 'ALL' | 'DOING' | 'READY' | 'ARCHIVED'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'ALL', label: '全部' },
  { value: 'DOING', label: '进行中' },
  { value: 'READY', label: '已完成' },
  { value: 'ARCHIVED', label: '垃圾桶' },
]

/**
 * 创作列表。
 *
 * ★ 分类是**前端按真实进度算的**（服务端 `status` 恒为 DRAFT，不能拿它筛）：
 *   「可拍可合成」= 文案与分镜都已生成；「进行中」= 其余；「垃圾桶」= 已归档。
 *   这样做的好处是与小程序完全一致 —— 同一个创作在两端出现在同一个分类里。
 * ★ 卡片不显示积分、不显示成片数量：这里只有「做到哪一步」这一个信息，多了就散了。
 */
export function CreationsPage() {
  const [filter, setFilter] = useState<Filter>('ALL')
  const [items, setItems] = useState<CreationItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (next: Filter) => {
    setLoading(true)
    setError(null)
    try {
      setItems(await listCreations({ archived: next === 'ARCHIVED' }))
    } catch (e) {
      setError(e instanceof Error ? e.message : '创作列表加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(filter)
  }, [filter, load])

  // 归档分类只显示已归档的；其余分类里「已归档」由服务端排除，这里再按进度分一次
  const shown = items.filter((item) => {
    if (filter === 'ARCHIVED') return true
    const { renderReady } = progressOf(item)
    if (filter === 'READY') return renderReady
    if (filter === 'DOING') return !renderReady
    return true
  })

  return (
    <WsPage
      title="创作"
      lead="一条创作 = 一段文案 + 一组分镜。先选菜和款式，生成文案，再拆成分镜，然后照着拍。"
    >
      {/* ★ 分类另起一行、按钮另起一行。
          原来把「新建创作」放在 `.ws-toolbar` 里跟分类同一行：390px 手机上分类被按钮挤掉
          三分之一宽度，四个分类折成两行、按钮悬在两行中间 —— 实测截图里那一块是全页最乱的。
          分类本身也不显示数量：这一页要回答的是「做到哪一步」，不是「有几条」
          （归档数量还要单独查一次，显示出来也容易是假数字）。 */}
      <div className="ws-chips">
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={filter === item.value}
            className={`ws-chip${filter === item.value ? ' active' : ''}`}
            onClick={() => setFilter(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="ws-actions ws-create-action">
        <Link className="button" to="/app/creations/new">新建创作</Link>
      </div>

      {error && <p className="action-error">{error}</p>}
      {loading && <p className="loading-block">正在读取创作…</p>}

      {!loading && !error && shown.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 6h16M4 12h10M4 18h7" />
            </svg>
          </div>
          <h3>{emptyTitle(filter)}</h3>
          <p>{emptyHint(filter)}</p>
          <Link className="button" to="/app/creations/new">新建一条创作</Link>
        </div>
      )}

      {shown.length > 0 && (
        <ul className="ws-list">
          {shown.map((item) => {
            const { pct, label } = progressOf(item)
            return (
              <li className="ws-list-item" key={item.id}>
                <Link className="ws-creation" to={`/app/creations/${item.id}`}>
                  <div className="ws-thumb">
                    {item.coverUrl
                      ? <img src={item.coverUrl} alt="" />
                      : <span className="ws-thumb-fallback">{item.title?.slice(0, 1) ?? '稿'}</span>}
                  </div>
                  <div className="ws-creation-main">
                    <h3>{item.title || '未命名创作'}</h3>
                    <p className="ws-list-meta">
                      {item.modeLabel && <span className="ws-tag">{item.modeLabel}</span>}
                      {item.trackLabel && <span className="ws-tag">{item.trackLabel}</span>}
                      {item.complexityLabel && <span className="ws-tag">{item.complexityLabel}</span>}
                      <span className="ws-creation-time">{formatCreationTime(item.createdAt)}</span>
                    </p>
                    <div className="ws-progressbar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                      <span style={{ width: `${pct}%` }} />
                    </div>
                    <p className="ws-creation-step">
                      <b>{pct}%</b>
                      {label}
                    </p>
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </WsPage>
  )
}

function emptyTitle(filter: Filter): string {
  if (filter === 'ARCHIVED') return '垃圾桶是空的'
  if (filter === 'READY') return '还没有可以拍的创作'
  if (filter === 'DOING') return '没有做到一半的创作'
  return '还没有创作'
}

function emptyHint(filter: Filter): string {
  if (filter === 'ARCHIVED') return '归档和删除的创作会放在这里，随时可以找回来。'
  if (filter === 'READY') return '文案和分镜都生成好之后，就会出现在这里。'
  if (filter === 'DOING') return '生成文案或分镜之后，没走完的会留在这里。'
  return '选一道招牌菜，让 AI 按你的资料写一条能照着念、照着拍的口播稿。'
}
