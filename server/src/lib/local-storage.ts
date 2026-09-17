// 本地开发文件存储：键格式与 COS 保持一致，方便明天无缝切换。
import { copyFile, mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { assertSafeObjectKey } from './object-key.js'

export type StorageMode = 'local' | 'cos'

/**
 * 允许本地落盘的键前缀白名单。
 *
 * `static/` 是「运营公开图」（首页轮播等）的前缀，由 services/public-asset.service.ts 写入。
 * 它与前两个的区别有两点，加新前缀前请一起确认：
 *   1) **公开可读**：COS 模式下上传时对每个对象单独设 `ACL: public-read`（桶仍是私有桶）；
 *   2) **不在 GC 扫描范围内**：gc-orphan-objects.ts 的「默认扫描前缀」与「删除前的硬编码
 *      前缀白名单」两处都只含 `uploads/,renders/,tutorials/`，**都没有 `static/`** ⇒
 *      这个前缀下的对象永远不会被当成孤儿回收。★ 这一条对它尤其关键：它**从不落库**
 *      （只存在 system_setting 的 JSON 里），所以「登记进 GC 的已引用键集合」这条常规
 *      保命路径对它完全无效，真正保命的就是「不在扫描前缀里」。挪进 uploads/ 会立刻踩雷。
 *      加新前缀时，请同时核对上面那两处名单。
 *
 * `tutorials/` 是「教学中心」视频与封面的前缀，由 services/tutorial.service.ts 写入。
 * 它是**平台级**资源（不属于任何商户），所以不能塞进 `uploads/{merchantId}/`
 * —— 那条前缀被 upload.service.ts 的越权校验与门店归属校验锁死。
 * 与 static/ 相反，它**必须**在 GC 扫描范围内：这些对象体积大（视频），
 * 而删除教学视频是硬删，靠 GC 兜底回收残留对象。
 */
const ALLOWED_PREFIXES = ['uploads/', 'renders/', 'static/', 'tutorials/']
const DEFAULT_ROOT = join(process.cwd(), 'storage')

/**
 * 存储中的一个对象（GC 工具与列表接口共用）。
 *
 * 放在这里而不是 cos.ts：`cos.ts` 已经 import 了本模块，反过来 import 会成环。
 * 本模块是「存储模式判定 + 本地实现」的中立层，类型定义放这里最合适。
 */
export interface StorageObject {
  /** 存储键（相对键，如 uploads/1/xxx.mp4 / renders/1/9.mp4） */
  key: string
  sizeBytes: number
  /** 最后修改时间（毫秒时间戳）；后端未提供时为 0 */
  lastModifiedMs: number
}

export function storageMode(env: NodeJS.ProcessEnv = process.env): StorageMode {
  return env.STORAGE_MODE === 'cos' ? 'cos' : 'local'
}

export function isLocalStorage(env: NodeJS.ProcessEnv = process.env): boolean {
  return storageMode(env) === 'local'
}

export function localStorageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.LOCAL_STORAGE_DIR?.trim() || DEFAULT_ROOT)
}

/** 将受控对象键映射为本地路径，拒绝绝对路径和目录穿越。 */
export function localPathForKey(key: string, env: NodeJS.ProcessEnv = process.env): string {
  // 纵深防御：这里的 relative(root, target) 只能保证不逃出**存储根目录**，
  // 保证不了不逃出**当前商户的前缀**（uploads/1/../../2/x 会落到商户 2 的目录）。
  // 所以入口处已用 assertSafeObjectKey 拦过一次，这里再拦一次便宜的。
  assertSafeObjectKey(key, 'local storage key')
  if (!ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix))) throw new Error('本地存储键前缀无效')
  const root = localStorageRoot(env)
  const target = resolve(root, key)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error('本地存储键路径无效')
  }
  return target
}

export async function ensureLocalStorage(): Promise<void> {
  await mkdir(localStorageRoot(), { recursive: true })
}

export async function copyLocalObjectToFile(key: string, targetPath: string): Promise<void> {
  await copyFile(localPathForKey(key), targetPath)
}

export async function copyFileToLocalObject(sourcePath: string, key: string): Promise<number> {
  const target = localPathForKey(key)
  await mkdir(dirname(target), { recursive: true })
  await copyFile(sourcePath, target)
  return (await stat(sourcePath)).size
}

/**
 * 从内存写到本地对象（运营公开图上传用）。
 *
 * 为什么单独一个函数：`copyFileToLocalObject` 的入口是**文件路径**（合成 worker 的产物、
 * multer 的中转文件都是落盘的），而公开图上传走的是 raw body —— 字节已经在内存里，
 * 再落一次临时文件纯属多余。
 */
export async function writeLocalObject(key: string, body: Buffer): Promise<number> {
  const target = localPathForKey(key)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, body)
  return body.length
}

export async function localObjectExists(key: string): Promise<boolean> {
  try {
    await stat(localPathForKey(key))
    return true
  } catch {
    return false
  }
}

export async function removeLocalFile(path: string): Promise<void> {
  await unlink(path).catch(() => undefined)
}

/**
 * 递归列举本地存储中所有匹配 `prefix` 的对象。
 *
 * 用途：孤儿对象 GC（scripts/gc-orphan-objects.ts）需要「存储里到底有什么」，
 * 而本地存储此前只有「按已知 key 查存在」的能力，无法反向列举。
 *
 * 实现要点：
 *   - 跳过所有以 `.` 开头的目录（如 `.incoming/`，那是 multer 的**上传中转目录**）。
 *     不跳的话，正在上传中的半成品文件会被当成孤儿对象统计进来。
 *   - 目录不存在时返回空数组而不抛错（本地模式首次运行 storage/ 可能还没建）。
 *   - 返回的 key 一律用 `/` 分隔，与 COS 键格式保持一致，调用方无需区分平台。
 */
export async function listLocalObjects(
  prefix: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StorageObject[]> {
  const root = localStorageRoot(env)
  const out: StorageObject[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // 跳过隐藏目录/文件：`.incoming` 是上传中转区，不属于对象存储内容
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      // 统一成 POSIX 风格相对键（Windows 下 sep 是 `\`）
      const key = relative(root, full).split(sep).join('/')
      if (!key.startsWith(prefix)) continue
      const st = await stat(full).catch(() => null)
      if (!st) continue
      out.push({ key, sizeBytes: st.size, lastModifiedMs: st.mtimeMs })
    }
  }

  await walk(root)
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** 删除单个本地对象。key 会被 localPathForKey 做安全校验（前缀 + 防穿越），非法键直接抛错。 */
export async function deleteLocalObject(key: string): Promise<void> {
  await removeLocalFile(localPathForKey(key))
}

function tokenSecret(): string {
  return process.env.APP_MASTER_KEY || process.env.JWT_SECRET || 'local-media-secret'
}

/** 生成给 video/downloadFile 使用的短期本地播放令牌。 */
export function createLocalMediaToken(key: string, ttlSeconds = 3600): { expires: number; token: string } {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds
  const payload = `${expires}.${key}`
  const token = createHmac('sha256', tokenSecret()).update(payload).digest('hex')
  return { expires, token }
}

export function verifyLocalMediaToken(key: string, expiresRaw: string, token: string): boolean {
  const expires = Number(expiresRaw)
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000) || !token) return false
  const expected = createHmac('sha256', tokenSecret()).update(`${expires}.${key}`).digest('hex')
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(token, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export function extensionForUpload(originalName: string, type: 'VIDEO' | 'IMAGE'): string {
  const ext = extname(basename(originalName)).toLowerCase().replace(/[^a-z0-9.]/g, '')
  if (ext && ext.length <= 10) return ext
  return type === 'IMAGE' ? '.jpg' : '.mp4'
}

export function contentTypeForKey(key: string): string {
  const ext = extname(key).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.png') return 'image/png'
  // webp/gif 是后补的：漏掉它们会落到下面的 video/mp4 默认值，
  // 于是头像（/api/v1/media/file）返回的 Content-Type 是视频，部分端直接不渲染
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  return 'video/mp4'
}
