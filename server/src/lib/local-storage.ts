// 本地开发文件存储：键格式与 COS 保持一致，方便明天无缝切换。
import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { assertSafeObjectKey } from './object-key.js'

export type StorageMode = 'local' | 'cos'

const ALLOWED_PREFIXES = ['uploads/', 'renders/']
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
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mov') return 'video/quicktime'
  return 'video/mp4'
}
