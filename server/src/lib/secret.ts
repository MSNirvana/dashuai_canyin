// API Key 加密存储：AES-256-GCM，主密钥走环境变量 APP_MASTER_KEY（64 位 hex）
// 密文格式：iv(12) | tag(16) | ciphertext

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALG = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

function masterKey(): Buffer {
  const hex = process.env.APP_MASTER_KEY
  if (!hex || hex.length !== 64) {
    throw new Error('APP_MASTER_KEY is missing or invalid (expect 64 hex chars)')
  }
  return Buffer.from(hex, 'hex')
}

export function encryptSecret(plain: string): Buffer {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALG, masterKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), enc])
}

export function decryptSecret(payload: Buffer | Uint8Array): string {
  const buf = Buffer.from(payload)
  const iv = buf.subarray(0, IV_LEN)
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const data = buf.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALG, masterKey(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

export function maskSecret(key: string): string {
  if (key.length <= 8) return '****'
  return `${key.slice(0, 3)}****${key.slice(-4)}`
}
