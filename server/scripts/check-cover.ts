/**
 * 封面抽帧诊断脚本：逐步打印「对象是否存在 → 下载 → ffmpeg 抽帧 → 上传」，
 * 一眼看出卡在哪一步（典型：COS 欠费导致 getObject 返回 451、ffmpeg 不在 PATH）。
 *
 * 用法：cd server && npx tsx scripts/check-cover.ts <videoKey>
 * 例：  npx tsx scripts/check-cover.ts renders/1/21.mp4
 *
 * 注意：必须最先 `import '../src/env.js'` 加载 .env，否则读不到 COS_ 前缀变量与 STORAGE_MODE，
 * storageMode 会误判成 local（默认值），诊断结论会完全跑偏。
 */
import '../src/env.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { downloadToFile, objectExists, uploadFile } from '../src/lib/cos.js'
import { generateVideoCover } from '../src/lib/thumbnail.js'
import { isLocalStorage, storageMode } from '../src/lib/local-storage.js'

const videoKey = process.argv[2] ?? 'renders/1/21.mp4'
const coverKey = `${videoKey.replace(/\/[^/]+$/, '')}/covers/${videoKey.replace(/^.*\//, '').replace(/\.[^.]+$/, '')}.jpg`

console.log('storageMode =', storageMode(), '| isLocal =', isLocalStorage())
console.log('videoKey =', videoKey)
console.log('coverKey =', coverKey)

console.log('\n[1] objectExists(videoKey) =', await objectExists(videoKey).catch((e) => `ERR ${e.message}`))
console.log('[2] objectExists(coverKey) =', await objectExists(coverKey).catch((e) => `ERR ${e.message}`))

const tmpVideo = join(tmpdir(), 'dbg-src.mp4')
const tmpCover = join(tmpdir(), 'dbg-out.jpg')
try {
  await downloadToFile(videoKey, tmpVideo)
  const { stat } = await import('node:fs/promises')
  console.log('[3] download OK, size =', (await stat(tmpVideo)).size)
} catch (e) {
  console.log('[3] download FAILED:', (e as Error).message)
  process.exit(1)
}

const r = await generateVideoCover(tmpVideo, tmpCover)
console.log('[4] generateVideoCover =', JSON.stringify(r))
if (!r.ok) {
  console.log('    → ffmpeg 抽帧失败，检查 FFMPEG_PATH / ffmpeg 是否在 PATH')
  process.exit(1)
}

try {
  const n = await uploadFile(tmpCover, coverKey, 'image/jpeg')
  console.log('[5] upload OK, bytes =', n)
} catch (e) {
  console.log('[5] upload FAILED:', (e as Error).message)
  process.exit(1)
}

console.log('[6] 复检 objectExists(coverKey) =', await objectExists(coverKey))
await Promise.all([rm(tmpVideo, { force: true }), rm(tmpCover, { force: true })])
