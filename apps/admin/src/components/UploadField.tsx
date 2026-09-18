import { useRef, useState, type ChangeEvent } from 'react'
import { Button, Tag, message } from 'tdesign-react'
import { request } from '../lib/http'

/**
 * 服务端上传接口的返回。不同 kind 带的字段不同，所以是可选的并集
 * （成片带 key/durationMs/coverKey，封面只带 key）。调用方按 kind 取用。
 */
export interface UploadedAsset {
  key: string
  sizeBytes: number
  /** 成片专用：ffprobe 探测到的时长；探测失败为 null（可手填） */
  durationMs?: number | null
  /** 成片专用：服务端抽帧得到的封面键；抽帧失败为 null */
  coverKey?: string | null
}

/**
 * 单个素材的上传控件：选文件 → 上传 → 把服务端返回的**对象键**交给调用方。
 *
 * 为什么后台的素材上传必须是「文件进、对象键出」，而不是让人手填地址：
 * 调用方拿到的这个键会被真正用于播放/交付，而手填的键有三个稳定发生的错法 ——
 * 抄错一位（存进去一切正常，用户端永远播不出来）、扩展名与真实容器不符
 * （Content-Type 跟着错，端上静默不播）、沿用固定键覆盖上传
 * （CDN / 微信按 URL 缓存，换了文件用户还看旧的）。上传控件把这三件事一次性堵住。
 *
 * ⚠ 两处细节不要「优化」掉：
 *   1) 选中文件后**立刻清空 input.value**。不清的话「再选同一个文件」不会触发 change，
 *      表现是上传失败后重试同一张图时按钮像坏了 —— 完全没有报错可循。
 *   2) `timeout: 0`。实例默认 30s，对上百 MB 的成片（尤其运营在弱网下）必然超时；
 *      而超时的表现是「传完了但报错」，运营会重复点，产生一堆无主对象。
 */
export default function UploadField({
  url,
  accept,
  maxMb,
  label,
  value,
  hint,
  disabled,
  onUploaded,
  onClear,
}: {
  /** 上传接口地址（已含查询串，如 `/render/tasks/1/deliver/upload?kind=video`） */
  url: string
  accept: string
  /** 前端预校验上限。★ 必须与服务端常量一致，且 nginx 的 client_max_body_size 要大于它 */
  maxMb: number
  label: string
  /** 当前已选中的对象键；非空即认为「已上传」 */
  value: string
  hint?: string
  disabled?: boolean
  onUploaded: (r: UploadedAsset) => void
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState(0)

  const pick = () => {
    if (busy || disabled) return
    inputRef.current?.click()
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // ★ 先清空 value 再上传：见组件顶部注释第 1 条
    e.target.value = ''
    if (!file) return

    const mb = file.size / 1024 / 1024
    if (mb > maxMb) {
      message.error(`文件不能超过 ${maxMb}MB（当前 ${mb.toFixed(1)}MB）`)
      return
    }

    setBusy(true)
    setPct(0)
    try {
      const fd = new FormData()
      // 字段名固定 file（服务端 multer.single('file')），不能改。
      // 也**不要**手写 Content-Type —— axios 会连 boundary 一起生成，
      // 手写反而会把 boundary 抹掉，服务端解析出一个空的 req.file。
      fd.append('file', file)
      const r = await request<UploadedAsset>({
        url,
        method: 'POST',
        data: fd,
        timeout: 0,
        onUploadProgress: (ev) => {
          if (ev.total) setPct(Math.round((ev.loaded / ev.total) * 100))
        },
      })
      message.success('上传完成')
      onUploaded(r)
    } catch {
      /* 失败原因已在 request 层 toast（含后端那句「只支持 MP4 / MOV / WebM / AVI 视频」） */
    } finally {
      setBusy(false)
      setPct(0)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input ref={inputRef} type="file" accept={accept} style={{ display: 'none' }} onChange={onFile} />
        <Button size="small" variant="outline" loading={busy} disabled={disabled} onClick={pick}>
          {busy ? `上传中 ${pct}%` : value ? '重新上传' : label}
        </Button>
        {value ? (
          <>
            <Tag theme="success">已上传</Tag>
            <Button size="small" variant="text" disabled={disabled} onClick={onClear}>
              清除
            </Button>
          </>
        ) : null}
      </div>
      {hint ? <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{hint}</div> : null}
    </div>
  )
}
