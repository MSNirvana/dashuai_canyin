import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { WsPage } from './workspace-ui'
import { getCreation, type CreationDetail } from './creations-data'
import { getPlayUrlByKey } from './media-upload'
import {
  GRADE_LABELS,
  getRenderGrades,
  getRenderTask,
  isRenderActive,
  isSelectableGrade,
  listRenders,
  renderTaskLabel,
  submitRender,
  type GradeCapability,
  type RenderGrade,
  type RenderTask,
} from './render-data'

/** 轮询间隔。合成一次几十秒到几分钟，2.5s 足够跟上进度又不至于打爆服务端 */
const POLL_MS = 2500

/**
 * 合成页（对应小程序的 `pages/render/compose`）。
 *
 * ★ 网页端与小程序的分工差别：小程序里这一页还要「补拍/重拍」，网页端只有**上传**，
 *   所以这里只做三件事 —— 看着素材齐不齐、选档位、提交并看成片。
 *   素材的增减都在创作详情页，不在本页重复一遍（两处都能改 = 两处都要维护一致）。
 *
 * ★★ 提交前必须把**这一档的积分**摆出来：价目来自 `/render/capabilities`，
 *   是后台可改的固定价，与成片时长无关 ⇒ 不用给「约」字。
 *
 * ★★★ 刷新页面后要能接着看进度：只在内存里记 taskId 的话，一刷新就「任务丢了」，
 *   而服务端还在跑、积分已经冻结。所以挂载时先用 `GET /renders` 找**进行中的那条**续上。
 */
export function RenderPage() {
  const { id } = useParams<{ id: string }>()
  const [creation, setCreation] = useState<CreationDetail | null>(null)
  const [grades, setGrades] = useState<GradeCapability[]>([])
  const [grade, setGrade] = useState<RenderGrade>('AI')
  const [task, setTask] = useState<RenderTask | null>(null)
  const [history, setHistory] = useState<RenderTask[]>([])
  const [playUrl, setPlayUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  const loadAll = useCallback(
    async (creationId: string) => {
      setError(null)
      try {
        const [detail, caps, renders] = await Promise.all([
          getCreation(creationId),
          getRenderGrades(),
          listRenders(creationId),
        ])
        if (!aliveRef.current) return
        setCreation(detail)
        setGrades(caps.grades)
        setHistory(renders)
        // 续上「正在跑」的那条（刷新后回来接着看），没有就展示最近一条终态结果
        const running = renders.find((r) => isRenderActive(r.status))
        setTask(running ?? renders[0] ?? null)
      } catch (e) {
        if (aliveRef.current) setError(e instanceof Error ? e.message : '加载失败')
      } finally {
        if (aliveRef.current) setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    aliveRef.current = true
    if (id) void loadAll(id)
    return () => {
      aliveRef.current = false
    }
  }, [id, loadAll])

  // 轮询：只有「进行中」的任务才转，终态立刻停（失败/取消也是终态）
  useEffect(() => {
    if (!id || !task || !isRenderActive(task.status)) return
    const timer = window.setInterval(async () => {
      try {
        const next = await getRenderTask(id, task.id)
        if (!aliveRef.current) return
        setTask(next)
        if (!isRenderActive(next.status)) {
          // 终态：刷新历史列表，让「刚出的这条」出现在下面
          const renders = await listRenders(id)
          if (aliveRef.current) setHistory(renders)
        }
      } catch {
        // 单次轮询失败不打断：网络抖一下不该把进度界面清掉，下一轮会自己补上
      }
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [id, task])

  // 成片地址按 key 现签：签名 URL 有有效期，不能落库缓存
  useEffect(() => {
    let alive = true
    if (!task || task.status !== 'SUCCESS' || !task.resultKey) {
      setPlayUrl(null)
      return
    }
    getPlayUrlByKey(task.resultKey)
      .then((r) => {
        if (alive) setPlayUrl(r.url)
      })
      .catch(() => {
        if (alive) setPlayUrl(null)
      })
    return () => {
      alive = false
    }
  }, [task])

  const readyAssets = creation?.shots.filter((shot) => shot.assetId).length ?? 0
  // ★ 只列「能选的」两档：接口会把已下线的基础档也返回来（历史记录要用），见 render-data.ts
  const options = grades.filter((g) => isSelectableGrade(g.key))
  const selected = options.find((g) => g.key === grade)
  const busy = Boolean(task && isRenderActive(task.status))

  const submit = async () => {
    if (!id || !creation) return
    if (readyAssets === 0) {
      setError('还没有一段素材，先回创作页给分镜传视频')
      return
    }
    const price = selected ? `${selected.beans} 积分` : '积分'
    if (!window.confirm(`按「${GRADE_LABELS[grade].title}」合成一次会扣 ${price}，合成期间可以离开页面，回来还能看进度。继续？`)) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await submitRender(id, { grade, mode: 'FULL' })
      setTask(result.task)
      if (result.duplicated) setError('这次提交命中了同一个请求（没有重复扣积分），下面就是那条任务。')
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <WsPage title="出成片"><p className="loading-block">正在读取…</p></WsPage>
  if (!creation) {
    return (
      <WsPage title="出成片">
        <p className="action-error">{error || '创作不存在'}</p>
        <Link className="button secondary" to="/app/creations">回到创作列表</Link>
      </WsPage>
    )
  }

  return (
    <WsPage
      title="出成片"
      lead={`${creation.title || '未命名创作'} · 素材 ${readyAssets}/${creation.shots.length} 段`}
    >
      <Link className="ws-back" to={`/app/creations/${creation.id}`}>← 回到这一条创作</Link>

      {error && <p className="action-error">{error}</p>}

      {/* ── 选档位并提交 ── */}
      <section className="ws-panel">
        <div className="ws-panel-head"><h2>选一个档位</h2></div>
        <div className="ws-chips">
          {options.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={grade === item.key}
              className={`ws-chip${grade === item.key ? ' active' : ''}`}
              disabled={!item.available}
              onClick={() => setGrade(item.key)}
            >
              {GRADE_LABELS[item.key]?.title ?? item.key}
              <span>{item.beans} 积分</span>
            </button>
          ))}
        </div>
        <p className="ws-hint">
          {GRADE_LABELS[grade]?.desc}
          {selected?.reason ? `（${selected.reason}）` : ''}
          。每次提交是固定价，和片子多长无关。
        </p>

        <div className="ws-actions ws-actions-inline" style={{ marginTop: 14 }}>
          <button className="button small" type="button" onClick={() => void submit()} disabled={submitting || busy || readyAssets === 0}>
            {submitting ? '提交中…' : busy ? '正在合成…' : '开始合成'}
          </button>
        </div>
        {readyAssets === 0 && <p className="ws-hint">先去创作页给分镜传视频，一段都没有时合成会被服务端直接拒掉。</p>}
      </section>

      {/* ── 当前任务 ── */}
      {task && (
        <section className="ws-panel">
          <div className="ws-panel-head">
            <h2>{renderTaskLabel(task.status)}</h2>
            <span className="ws-count">{Math.max(0, Math.min(100, task.progress))}%</span>
          </div>
          <div className="ws-progressbar" role="progressbar" aria-valuenow={task.progress} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }} />
          </div>

          {isRenderActive(task.status) && (
            <p className="ws-hint">
              可以不守在这一页，关掉网页也会继续合成；回来刷新还能接上。本档扣 {Number(task.beanCharged)} 积分。
            </p>
          )}

          {task.status === 'FAILED' && (
            <p className="action-error">{task.errorText || '合成失败，可以换一档再试，或检查素材是否完整。'}</p>
          )}

          {task.status === 'SUCCESS' && (
            <div className="ws-result">
              {playUrl ? (
                <video className="ws-video" src={playUrl} controls playsInline preload="metadata" />
              ) : (
                <p className="ws-hint">成片地址正在签名…</p>
              )}
              <div className="ws-actions ws-actions-inline">
                {playUrl && (
                  <a className="button small secondary" href={playUrl} target="_blank" rel="noreferrer" download>
                    下载成片
                  </a>
                )}
                <span className="ws-hint">
                  {Number(task.beanCharged)} 积分已扣
                  {task.durationMs ? ` · 成片 ${Math.round(task.durationMs / 1000)} 秒` : ''}
                </span>
              </div>
            </div>
          )}
        </section>
      )}

      {/* ── 历史 ── */}
      {history.length > 1 && (
        <section className="ws-panel">
          <div className="ws-panel-head"><h2>合成记录</h2></div>
          <ul className="ws-list">
            {history.map((item) => (
              <li className="ws-list-item" key={item.id}>
                <div className="ws-list-main">
                  <h3>{GRADE_LABELS[item.grade]?.title ?? item.grade}</h3>
                  <p className="ws-list-meta">
                    <span className="ws-tag">{renderTaskLabel(item.status)}</span>
                    <span>{Number(item.beanCharged)} 积分</span>
                    {item.createdAt ? <span>{new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</span> : null}
                  </p>
                </div>
                <div className="ws-list-actions">
                  <button className="button small ghost" type="button" onClick={() => setTask(item)}>
                    {item.id === task?.id ? '正在看' : '看这条'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </WsPage>
  )
}
