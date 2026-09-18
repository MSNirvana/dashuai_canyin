import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Button, Tag, message } from 'tdesign-react'
import { request } from '../lib/http'

/**
 * 单个素材的上传控件：选文件 → 上传 → 回填**对象键**。
 *
 * 做成一体的原因：用到它的页面里都有视频和封面两个位置，拆成「按钮 + 状态 + 进度 + 清空」
 * 四套 state 会让页面主体被上传逻辑淹没，而几处的行为完全一样（只有接口路径、
 * 大小上限与 accept 不同）。
 *
 * 为什么用原生 `input[type=file]` + 本项目 `lib/http` 的 axios 实例，而不是 tdesign 的 Upload：
 *   · 组件自带的请求实现会**绕过拦截器**里的 Authorization 与统一错误提示 ——
 *     401 不会跳登录，后端那句「只支持 MP4 / MOV / WebM / AVI 视频」也不会显示出来，
 *     运营只会看到「上传失败」；
 *   · 这里要的就是「表单里一个文件输入 + 我自己决定什么时候传」，原生 input 已经够，
 *     少一层不受控的黑盒。
 *
 * 本组件从 pages/Tutorials.tsx 提出来，供「教学视频」与「优秀作品」共用：
 * 两处除了 endpoint 之外逐字相同，抄第二份的话下次改超时/加进度提示必然漏一个。
 */

/** 服务端 upload 接口的返回（两种 kind 的字段不同） */
export interface AssetUploadResult {
  videoKey?: string
  coverKey?: string
  sizeBytes: number
  contentType?: string
}

export default function AssetUploader({
  endpoint,
  kind,
  accept,
  maxMb,
  uploadLabel,
  value,
  hint,
  onUploaded,
  onClear,
}: {
  /** 服务端上传端点（相对 /admin/api/v1），如 `/works/upload` */
  endpoint: string
  kind: 'video' | 'cover'
  accept: string
  maxMb: number
  uploadLabel: string
  value: string
  hint?: string
  onUploaded: (r: AssetUploadResult) => void
  onClear: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [pct, setPct] = useState(0)

  const pick = () => {
    if (busy) return
    inputRef.current?.click()
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // 立刻清空 input 的值：不清的话「再选同一个文件」不会触发 change，运营会以为按钮坏了
    e.target.value = ''
    if (!file) return

    const mb = file.size / 1024 / 1024
    if (mb > maxMb) {
      message.error(`${kind === 'video' ? '视频' : '封面'}不能超过 ${maxMb}MB（当前 ${mb.toFixed(1)}MB）`)
      return
    }

    setBusy(true)
    setPct(0)
    try {
      const fd = new FormData()
      // 字段名固定 file（服务端 multer.single('file')），不能改
      fd.append('file', file)
      const r = await request<AssetUploadResult>({
        url: `${endpoint}?kind=${kind}`,
        method: 'POST',
        data: fd,
        // 默认 30s 不够：100MB 上传（尤其运营在弱网下）轻松超时
        timeout: 0,
        onUploadProgress: (ev) => {
          if (ev.total) setPct(Math.round((ev.loaded / ev.total) * 100))
        },
      })
      message.success(`${kind === 'video' ? '视频' : '封面'}已上传`)
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
        <Button size="small" variant="outline" loading={busy} onClick={pick}>
          {busy ? `上传中 ${pct}%` : value ? '重新上传' : uploadLabel}
        </Button>
        {value ? (
          <>
            <Tag theme="success">已上传</Tag>
            <Button size="small" variant="text" onClick={onClear}>
              清除
            </Button>
          </>
        ) : null}
      </div>
      {value ? (
        <div style={{ marginTop: 6, fontSize: 12, color: '#888', wordBreak: 'break-all' }}>{value}</div>
      ) : null}
      {hint ? <div style={{ marginTop: 6, fontSize: 12, color: '#999' }}>{hint}</div> : null}
    </div>
  )
}
