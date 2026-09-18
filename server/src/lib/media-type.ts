// 按**文件头**判定媒体类型的公共件（视频容器 + 只读文件头的小工具）。
//
// ── 为什么必须嗅探，而不是信文件名 / Content-Type ──────────────────────────
// 落库的对象键会被 `lib/local-storage.ts::contentTypeForKey()` 翻译成响应头里的
// Content-Type。文件名完全由客户端控制，一个 `.mp4` 结尾的 webm 会让服务端声明
// `video/mp4`，端上按 mp4 解复用 ⇒ **静默不播**，日志里一行报错都没有。
// 从判定结果取扩展名，这条链上的三处（存储键、Content-Type、端上行为）就都可信了。
//
// 本文件从 services/tutorial.service.ts 抽出来：那里原本是唯一的调用方，
// 现在「优秀作品」的视频上传也要用同一套（两份判定逻辑迟早会漂）。
import { open } from 'node:fs/promises'

export interface DetectedType {
  ext: string
  contentType: string
}

/**
 * 视频容器嗅探。
 *
 * ⚠ 返回 `null` 必须被调用方当成**拒绝**（而不是「未知就当 mp4」）：
 *   放行任意字节等于开了一个「把任何文件写进对象存储」的口子。
 */
export function detectVideoType(buf: Buffer): DetectedType | null {
  // mp4 / m4v / mov：尺寸字段之后紧接着牌子 'ftyp'
  if (buf.length >= 8 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    return buf.subarray(8, 12).toString('latin1') === 'qt  '
      ? { ext: '.mov', contentType: 'video/quicktime' }
      : { ext: '.mp4', contentType: 'video/mp4' }
  }
  // Matroska / WebM：EBML 头
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return { ext: '.webm', contentType: 'video/webm' }
  }
  // AVI：RIFF 容器 + 'AVI ' 牌子
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'AVI '
  ) {
    return { ext: '.avi', contentType: 'video/x-msvideo' }
  }
  return null
}

/**
 * 只读文件头 N 字节判类型。
 *
 * ★ 不要 `readFile()` 整个文件：上传的可能是 100MB 视频，为了判 16 个字节把它全部
 *   读进内存，多文件并发时足以打爆进程。
 *
 * 读不到（文件不存在 / 无权限）时返回 `null`，由调用方按「类型未知」拒绝。
 */
export async function readFileHead(path: string, n: number): Promise<Buffer | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(path, 'r')
    const buf = Buffer.alloc(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return buf.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => undefined)
  }
}
