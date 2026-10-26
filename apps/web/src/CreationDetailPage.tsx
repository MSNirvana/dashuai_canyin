import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { WsPage } from './workspace-ui'
import { uploadVideo } from './media-upload'
import {
  archiveCreation,
  deleteCreation,
  formatCreationTime,
  generateCopy,
  generateStoryboard,
  getCreation,
  patchCreation,
  progressOf,
  unarchiveCreation,
  updateShot,
  type CreationDetail,
  type Shot,
} from './creations-data'

/**
 * 创作详情：文案 + 分镜。
 *
 * ★ 这一页只做「文字」这一段（小程序里的编辑页 / 分镜页合起来）。
 *   拍摄、绑素材、合成留给后续页面 —— 硬塞进来会让一屏变成五段。
 * ★★ 生成会**扣积分**，所以两个按钮都先 `confirm` 一次，并在成功后把 `beanCharged`
 *   如实显示出来（服务端返回真实数字，不在前端猜价）。
 * ★ 「文案没生成就生成分镜」是允许的（服务端有兜底模板），但页面上会提示：
 *   分镜提示词里要喂 `copyText`，空的会让镜头台词变成空话。
 */
export function CreationDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [data, setData] = useState<CreationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copyText, setCopyText] = useState('')
  const [busy, setBusy] = useState<'copy' | 'shots' | 'save' | 'archive' | 'delete' | null>(null)
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const [editingShot, setEditingShot] = useState<string | null>(null)

  const load = useCallback(async (target: string) => {
    setLoading(true)
    setError(null)
    try {
      const detail = await getCreation(target)
      setData(detail)
      setCopyText(detail.copyText ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : '创作加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (id) void load(id)
  }, [id, load])

  const saveCopy = async () => {
    if (!data) return
    setBusy('save')
    setNotice(null)
    try {
      await patchCreation(data.id, { copyText })
      setNotice({ ok: true, text: '文案已保存' })
      await load(data.id)
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '保存失败' })
    } finally {
      setBusy(null)
    }
  }

  const runCopy = async () => {
    if (!data) return
    const verb = data.copyText ? '重新生成' : '生成'
    if (!window.confirm(`${verb}文案会消耗积分，${verb}后原来的文案会被覆盖。继续？`)) return
    setBusy('copy')
    setNotice(null)
    try {
      const result = await generateCopy(data.id)
      // ★ 先 load 再回填：`load` 会把 copyText 一起 set 成**服务端当前值**。
      //   如果先回填再 load，任何一次「服务端还没读到刚写的文案」都会把界面上
      //   刚生成的结果覆盖回旧稿 —— 用户会以为「生成了但没变」。
      //   回填放在 load 之后，保证「生成出来的这一段」永远是屏幕上显示的那一段。
      await load(data.id)
      setCopyText(result.text)
      setNotice({
        ok: true,
        text: `文案已${verb}，消耗 ${Number(result.beanCharged)} 积分${result.isFallbackTemplate ? '（本次用了兜底模板，可以再试一次）' : ''}`,
      })
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '生成失败' })
    } finally {
      setBusy(null)
    }
  }

  const runStoryboard = async () => {
    if (!data) return
    const verb = data.shots.length > 0 ? '重新生成' : '生成'
    if (!window.confirm(`${verb}分镜会消耗积分，${verb}后原来的分镜会被整批替换${data.shots.length > 0 ? '（已经排好的镜头会没了）' : ''}。继续？`)) return
    setBusy('shots')
    setNotice(null)
    try {
      const result = await generateStoryboard(data.id)
      setNotice({
        ok: true,
        text: `${result.shots.length} 个分镜已生成，消耗 ${Number(result.beanCharged)} 积分${result.isFallbackTemplate ? '（本次用了兜底模板，可以再试一次）' : ''}`,
      })
      await load(data.id)
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '生成失败' })
    } finally {
      setBusy(null)
    }
  }

  const toggleArchive = async () => {
    if (!data) return
    setBusy('archive')
    setNotice(null)
    try {
      if (data.archivedAt) await unarchiveCreation(data.id)
      else await archiveCreation(data.id)
      setNotice({ ok: true, text: data.archivedAt ? '已恢复到列表' : '已移入垃圾桶，可以随时找回' })
      await load(data.id)
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '操作失败' })
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!data) return
    if (!window.confirm(`删除「${data.title || '未命名创作'}」？删除后不会出现在任何分类里。`)) return
    setBusy('delete')
    try {
      await deleteCreation(data.id)
      navigate('/app/creations', { replace: true })
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '删除失败' })
      setBusy(null)
    }
  }

  if (loading) return <WsPage title="创作详情"><p className="loading-block">正在读取…</p></WsPage>
  if (error || !data) {
    return (
      <WsPage title="创作详情">
        <p className="action-error">{error || '创作不存在'}</p>
        <Link className="button secondary" to="/app/creations">回到创作列表</Link>
      </WsPage>
    )
  }

  const { pct, label } = progressOf(data)
  // 「已传素材」口径与合成一致：有 assetId 的才算（跳过的不补位、也不参与合成）
  const readyShots = data.shots.filter((shot) => shot.assetId).length

  return (
    <WsPage title={data.title || '未命名创作'} lead={`${formatCreationTime(data.createdAt)}创建 · ${label}`}>
      <Link className="ws-back" to="/app/creations">← 回到创作列表</Link>

      <p className="ws-meta-row">
        {data.modeLabel && <span className="ws-tag">{data.modeLabel}</span>}
        {data.trackLabel && <span className="ws-tag">{data.trackLabel}</span>}
        {data.complexityLabel && <span className="ws-tag">{data.complexityLabel}</span>}
        {data.dish?.name && <span className="ws-tag">菜品 · {data.dish.name}</span>}
      </p>

      {/* 进度条 + 百分数同一行。
          ★ 用中性灰的返回链、不用红字：红条就紧跟在这行下面，
            返回链也用红的话，那条 6px 的红进度条会被读成「链接的下划线」（实测截图里就是这样）。 */}
      <div className="ws-progress-row">
        <div className="ws-progressbar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
        <span className="ws-progress-num">{pct}%</span>
      </div>
      <p className="ws-creation-step">{label}</p>

      {notice && <p className={notice.ok ? 'ws-ok' : 'action-error'}>{notice.text}</p>}

      {/* ── 第一步：文案 ── */}
      <section className="ws-panel">
        <div className="ws-panel-head">
          <h2>1 · 口播文案</h2>
          <button className="button small secondary" type="button" onClick={() => void runCopy()} disabled={busy !== null}>
            {busy === 'copy' ? '生成中…' : data.copyText ? '重新生成' : '生成文案'}
          </button>
        </div>
        <textarea
          className="ws-textarea"
          value={copyText}
          onChange={(e) => setCopyText(e.target.value)}
          rows={9}
          maxLength={20000}
          placeholder="点右上角「生成文案」，或者直接在这里手写。写完之后再拆分镜。"
        />
        <p className="ws-hint">
          字数 {copyText.trim().length}。文案会原样喂给分镜生成，所以「念起来顺」比「写得好」重要。
        </p>
        <div className="ws-actions ws-actions-inline">
          <button
            className="button small quiet"
            type="button"
            onClick={() => void saveCopy()}
            disabled={busy !== null || copyText === (data.copyText ?? '')}
          >
            {busy === 'save' ? '保存中…' : '保存文案'}
          </button>
        </div>
      </section>

      {/* ── 第二步：分镜 ── */}
      <section className="ws-panel">
        <div className="ws-panel-head">
          <h2>2 · 分镜脚本</h2>
          <button className="button small secondary" type="button" onClick={() => void runStoryboard()} disabled={busy !== null}>
            {busy === 'shots' ? '生成中…' : data.shots.length > 0 ? '重新生成分镜' : '生成分镜'}
          </button>
        </div>

        {!data.copyText && data.shots.length === 0 && (
          <p className="ws-hint">先有文案再拆分镜，镜头台词才不会空着。</p>
        )}

        {data.shots.length === 0 ? (
          <p className="ws-hint">还没有分镜。生成之后，每个镜头会写清「拍什么、说什么、拍多久」。</p>
        ) : (
          <ul className="ws-shots">
            {data.shots.map((shot) => (
              <ShotRow
                key={shot.id}
                shot={shot}
                storeId={data.storeId}
                editing={editingShot === shot.id}
                onEdit={() => setEditingShot(editingShot === shot.id ? null : shot.id)}
                onSaved={(text) => {
                  setNotice({ ok: true, text })
                  setEditingShot(null)
                  void load(data.id)
                }}
                creationId={data.id}
              />
            ))}
          </ul>
        )}
      </section>

      {/* ── 第三步：出成片 ──
          这一屏的**唯一红实心按钮**放在这里：整条链路的目标就是出片，
          所以「保存文案」降级成灰底（`.button.quiet`），不跟它抢。 */}
      <section className="ws-panel">
        <div className="ws-panel-head"><h2>3 · 出成片</h2></div>
        <p className="ws-hint" style={{ marginTop: 0 }}>
          {readyShots === 0
            ? '还没有一段素材。先把拍好的视频传到对应分镜上，再合成。'
            : `已传 ${readyShots}/${data.shots.length} 段${readyShots < data.shots.length ? '，剩下的要么补传，要么标成「这段不拍」。' : '，可以合成了。'}`}
        </p>
        <div className="ws-actions ws-actions-inline" style={{ marginTop: 14 }}>
          {/* ★ 没素材时给**真的 disabled 按钮**，不是给 <Link> 加 `pointer-events:none`：
              后者挡不住键盘 Enter 与脚本点击，用户照样能进到一个「什么都不能做」的合成页 ——
              而服务端那边会以 4003「请先为分镜上传素材」把提交打回来。 */}
          {readyShots === 0 ? (
            <button className="button small" type="button" disabled>去合成成片</button>
          ) : (
            <Link className="button small" to={`/app/creations/${data.id}/render`}>去合成成片</Link>
          )}
        </div>
      </section>

      {/* ── 其他操作 ── */}
      <section className="ws-panel">
        <div className="ws-panel-head"><h2>这条创作</h2></div>
        <div className="ws-actions ws-actions-inline">
          <button className="button small ghost" type="button" onClick={() => void toggleArchive()} disabled={busy !== null}>
            {data.archivedAt ? '恢复到列表' : '移入垃圾桶'}
          </button>
          <button className="icon-text-button" type="button" onClick={() => void remove()} disabled={busy !== null}>
            删除这条创作
          </button>
        </div>
        <p className="ws-hint">
          删除是不可恢复的（服务端软删，两端都看不到）。只想从列表里清掉、以后还想找回，用「移入垃圾桶」。
        </p>
      </section>
    </WsPage>
  )
}

/** 单个分镜：默认只读，点「改台词」才展开两个输入框（列表里全是输入框会没法扫读） */
function ShotRow({
  shot,
  storeId,
  editing,
  onEdit,
  onSaved,
  creationId,
}: {
  shot: Shot
  storeId: string
  editing: boolean
  onEdit: () => void
  onSaved: (text: string) => void
  creationId: string
}) {
  const [line, setLine] = useState(shot.line ?? '')
  const [visualReq, setVisualReq] = useState(shot.visualReq ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadPercent, setUploadPercent] = useState<number | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // 外部数据变了（重新生成分镜）要跟着回填，否则输入框里还是旧台词
  useEffect(() => {
    setLine(shot.line ?? '')
    setVisualReq(shot.visualReq ?? '')
  }, [shot.line, shot.visualReq])

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      await updateShot(creationId, shot.id, { line, visualReq })
      onSaved(`第 ${shot.seq} 镜已保存`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  /**
   * 选文件 → 上传 → 绑到这个分镜。
   *
   * ★ 三步都可能失败，且失败后**不能**把 assetId 绑上去（文件没传成却绑了 id，
   *   会让这个分镜永远停在「已上传」，合成时找不到对象直接失败）。
   * ★ 上传成功但绑定失败时，素材已经在库里了 —— 提示里说清「文件已传到云端，
   *   重新点一次上传会再传一遍」，让用户知道重试的代价（不能悄悄重复占配额）。
   */
  const pickFile = async (file: File) => {
    setError(null)
    setUploadPercent(0)
    try {
      const { asset } = await uploadVideo(file, {
        storeId,
        onProgress: (p) => setUploadPercent(p.percent),
      })
      await updateShot(creationId, shot.id, { assetId: asset.id })
      onSaved(`第 ${shot.seq} 镜的素材已上传`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '上传失败')
    } finally {
      setUploadPercent(null)
      // 清掉 input 的选中值：不清的话「选同一个文件」不会再触发 change
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const toggleSkip = async () => {
    setError(null)
    setSaving(true)
    try {
      await updateShot(creationId, shot.id, { skipped: !shot.skipped })
      onSaved(shot.skipped ? `第 ${shot.seq} 镜已恢复` : `第 ${shot.seq} 镜标为不拍`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      setSaving(false)
    }
  }

  const uploading = uploadPercent !== null

  return (
    <li className="ws-shot">
      <div className="ws-shot-head">
        <b>第 {shot.seq} 镜</b>
        <span className="ws-list-meta">
          {shot.shotType && <span className="ws-tag">{shot.shotType}</span>}
          {shot.shotSize && <span className="ws-tag">{shot.shotSize}</span>}
          {shot.durationSuggest ? <span className="ws-tag">{shot.durationSuggest}s</span> : null}
          {shot.assetId ? <span className="ws-tag ok">已传素材</span> : null}
          {shot.skipped ? <span className="ws-tag">这段不拍</span> : null}
        </span>
        <button className="icon-text-button" type="button" onClick={onEdit}>
          {editing ? '收起' : '改台词'}
        </button>
      </div>

      {shot.line && !editing && <p className="ws-shot-line">「{shot.line}」</p>}
      {shot.visualReq && !editing && <p className="ws-shot-visual">画面：{shot.visualReq}</p>}

      {/* 素材：网页端没有「拍摄」，只有选文件。这也正是「哪一段还没拍」最需要被看见的地方 */}
      <div className="ws-shot-asset">
        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void pickFile(file)
          }}
        />
        {uploading ? (
          <div className="ws-upload">
            <div className="ws-progressbar"><span style={{ width: `${uploadPercent}%` }} /></div>
            <span className="ws-upload-text">上传中 {uploadPercent}%</span>
          </div>
        ) : (
          <>
            <button className="button small ghost" type="button" onClick={() => fileRef.current?.click()} disabled={saving}>
              {shot.assetId ? '换一个视频' : '上传视频'}
            </button>
            <button className="icon-text-button" type="button" onClick={() => void toggleSkip()} disabled={saving}>
              {shot.skipped ? '恢复这段' : '这段不拍'}
            </button>
          </>
        )}
      </div>

      {error && <p className="action-error">{error}</p>}
      {editing && (
        <div className="ws-shot-edit">
          <label className="ws-field">
            <span className="ws-label">这一镜说什么</span>
            <textarea className="ws-textarea" rows={3} value={line} onChange={(e) => setLine(e.target.value)} maxLength={2000} />
          </label>
          <label className="ws-field">
            <span className="ws-label">这一镜拍什么</span>
            <textarea className="ws-textarea" rows={3} value={visualReq} onChange={(e) => setVisualReq(e.target.value)} maxLength={2000} />
          </label>
          {error && <p className="action-error">{error}</p>}
          <div className="ws-actions">
            <button className="button small" type="button" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : '保存这一镜'}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}
