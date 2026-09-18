import { useEffect, useState } from 'react'
import { Button, Dialog, Input, InputNumber, Switch, message } from 'tdesign-react'
import Field, { FieldGroup } from './Field'
import UploadField, { type UploadedAsset } from './UploadField'
import { request } from '../lib/http'
import type { RenderRow } from '../lib/render-task'

/**
 * 交付成片弹窗（「合成任务」与「精品接单」共用）。
 *
 * ── 为什么把「上传成片」放在这里，而不是让人手填对象键 ──────────────────────
 * 交付接口收的是对象键，而后台此前没有上传端点 ⇒ 剪辑师只能在别处把成片传上去、
 * 再把键抄进来。这条路上有四种**不会报错**的失败：抄错一位（交付成功、用户端永远
 * 播不出来）、扩展名与容器不符（Content-Type 错、端上静默不播）、沿用固定键覆盖
 * （CDN 按 URL 缓存，换了成片用户还看旧的）、以及最隐蔽的——键的前缀不在本商户
 * 名下（既不能播，还可能是别人的文件）。上传控件把前三个堵住，
 * `assertMerchantKeyPrefix` 与交付接口的服务端校验一起堵住第四个。
 *
 * 手填键的入口**刻意保留**（开关默认关）：从别处已经把成片传好的情况是真实存在的，
 * 直接砍掉会逼人绕路。但它默认关着，正常路径上没人会走到它。
 */
export default function DeliverDialog({
  task,
  onClose,
  onDone,
}: {
  /** 为 null 时弹窗关闭 */
  task: RenderRow | null
  onClose: () => void
  onDone: () => void
}) {
  const [resultKey, setResultKey] = useState('')
  const [previewKey, setPreviewKey] = useState('')
  const [resultSize, setResultSize] = useState<number | undefined>(undefined)
  const [durationSec, setDurationSec] = useState<number | undefined>(undefined)
  /** 手动填键模式（默认关：正常路径是上传） */
  const [manual, setManual] = useState(false)
  /** 时长是否被人工改过。改过就不再被后续上传的探测值覆盖 */
  const [durationTouched, setDurationTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // 每次换任务都重置：不重置的话，「交付 A 上传的成片」会被带到 B 的弹窗里，
  // 而两个弹窗长得一模一样，交付下去就是把 A 的视频交到了 B 的任务上。
  useEffect(() => {
    if (!task) return
    setResultKey('')
    setPreviewKey('')
    setResultSize(undefined)
    setDurationSec(undefined)
    setManual(false)
    setDurationTouched(false)
  }, [task])

  const close = () => {
    if (submitting) return
    onClose()
  }

  /**
   * 键必须落在**本商户**的前缀下。
   *
   * ★ 这条不是「体验优化」：用户端拿成片地址走 `GET /media/play-url`，那里的闸门只放行
   *   `uploads/{merchantId}/` 与 `renders/{merchantId}/`。键写错前缀的话交付会成功、
   *   库里看着一切正常，而用户端**永远播不出来**、也没有任何日志。服务端同样有这道校验
   *   （premium.ts），这里只是让运营当场就看到原因，而不是等客户来投诉。
   */
  const prefixError = (key: string): string => {
    if (!task) return ''
    const k = key.trim()
    if (!k) return '还没上传成片'
    if (!k.startsWith(`renders/${task.merchantId}/`) && !k.startsWith(`uploads/${task.merchantId}/`)) {
      return `成片键必须落在 renders/${task.merchantId}/ 或 uploads/${task.merchantId}/ 下（当前不是），否则用户端签不出播放地址`
    }
    return ''
  }

  const onVideoUploaded = (r: UploadedAsset) => {
    setResultKey(r.key)
    setResultSize(r.sizeBytes)
    // 探测成功才回填，且不覆盖人工已改过的值 —— 自动值盖掉人的输入是最让人恼火的一种行为
    if (typeof r.durationMs === 'number' && r.durationMs > 0 && !durationTouched) {
      setDurationSec(Math.round(r.durationMs / 1000))
    }
    // 抽帧封面：只在运营还没指定封面时才用，避免把人工选的封面顶掉
    if (r.coverKey && !previewKey) setPreviewKey(r.coverKey)
  }

  const submit = async () => {
    if (!task) return
    const err = prefixError(resultKey)
    if (err) {
      message.warning(err)
      return
    }
    setSubmitting(true)
    try {
      await request({
        url: `/render/tasks/${task.id}/deliver`,
        method: 'POST',
        data: {
          resultKey: resultKey.trim(),
          ...(previewKey.trim() ? { previewKey: previewKey.trim() } : {}),
          // 上传过才带上：真实字节数，比让服务端猜准；手填模式下没有这个信息就不传
          ...(resultSize ? { resultSize } : {}),
          ...(durationSec ? { durationMs: Math.round(durationSec * 1000) } : {}),
        },
      })
      message.success('已交付，积分已结算')
      onDone()
      onClose()
    } catch {
      /* 已在 request 层 toast */
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog
      header={`交付成片 · 任务 #${task?.id ?? ''}`}
      visible={!!task}
      onClose={close}
      footer={
        <div style={{ textAlign: 'right' }}>
          <Button variant="outline" disabled={submitting} onClick={close} style={{ marginRight: 8 }}>
            取消
          </Button>
          <Button theme="primary" loading={submitting} onClick={submit}>
            确认交付
          </Button>
        </div>
      }
      width={620}
    >
      <FieldGroup labelWidth={110}>
        <Field label="成片视频" help="支持 MP4 / MOV / WebM / AVI，单个不超过 100MB。上传后会自动探测时长并抽一帧当封面。">
          <UploadField
            url={`/render/tasks/${task?.id ?? ''}/deliver/upload?kind=video`}
            accept="video/mp4,video/quicktime,video/webm,video/x-msvideo,.mp4,.mov,.webm,.avi"
            maxMb={100}
            label="选择成片并上传"
            value={resultKey}
            onUploaded={onVideoUploaded}
            onClear={() => {
              setResultKey('')
              setResultSize(undefined)
            }}
          />
        </Field>

        <Field label="封面（可选）" help="不传就用服务端抽的那一帧；也可以自己传一张更好看的。">
          <UploadField
            url={`/render/tasks/${task?.id ?? ''}/deliver/upload?kind=cover`}
            accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif"
            maxMb={5}
            label="选择封面并上传"
            value={previewKey}
            onUploaded={(r) => setPreviewKey(r.key)}
            onClear={() => setPreviewKey('')}
          />
        </Field>

        <Field label="成片时长（秒）" help="上传成片时自动探测；探测失败才需要手填。">
          <InputNumber
            value={durationSec}
            onChange={(v) => {
              setDurationTouched(true)
              setDurationSec(v === undefined ? undefined : Number(v))
            }}
            min={0}
          />
        </Field>
      </FieldGroup>

      <div style={{ marginTop: 12, borderTop: '1px solid #e7e7e7', paddingTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Switch size="small" value={manual} onChange={(v) => setManual(!!v)} />
          <span style={{ fontSize: 13 }}>手动填写对象键</span>
          <span className="muted" style={{ fontSize: 12 }}>
            （成片已在别处传好时才用；键必须落在本商户目录下，否则用户端播不出来）
          </span>
        </div>
        <Input
          value={resultKey}
          // tdesign 的 Input 用的是 HTML 原生拼法 `readonly`（全小写），不是 React 惯例的 readOnly
          readonly={!manual}
          onChange={(v) => setResultKey(v as string)}
          status={resultKey && prefixError(resultKey) ? 'error' : undefined}
          placeholder={manual ? `如 renders/${task?.merchantId ?? ''}/${task?.id ?? ''}.mp4` : '上传成片后这里会自动填上'}
        />
        {resultKey && prefixError(resultKey) ? (
          <div className="danger-text" style={{ fontSize: 12, marginTop: 4 }}>{prefixError(resultKey)}</div>
        ) : null}
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>
        交付后立即结算用户积分（按提交时冻结金额），任务标记完成，用户端即可播放。
        <br />
        只上传、没点「确认交付」的话，那个视频不会被任何任务引用，会在存储保留期后自动回收。
      </div>
    </Dialog>
  )
}
