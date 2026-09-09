// 本地开发文件存储：键格式与 COS 保持一致，方便明天无缝切换。
import { copyFile, mkdir, stat, unlink } from 'node:fs/promises'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'

export type StorageMode = 'local' | 'cos'

const ALLOWED_PREFIXES = ['uploads/', 'renders/']
const DEFAULT_ROOT = join(process.cwd(), 'storage')

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
