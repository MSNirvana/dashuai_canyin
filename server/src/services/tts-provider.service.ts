// TTS 供应商后台配置服务（腾讯云 / 火山引擎）
// API Key 用 AES-256-GCM 加密落库（复用 lib/secret 的 APP_MASTER_KEY），对外只暴露掩码；
// 运行时解密仅在合成链路（render/synthesis）使用，绝不下发明文。
// 凭证语义（两种厂商共用一套通用字段）：
//   - tencent：appId=腾讯云 AppId，secretId=SecretId，apiKey=SecretKey
//   - volcano：appId=火山 AppId，apiKey=AccessToken（secretId 可空）
import type { PrismaClient } from '@prisma/client'
import { encryptSecret, decryptSecret, maskSecret } from '../lib/secret.js'

/** 运行时配置（已解密，仅合成链路内部使用） */
export interface TtsProviderConfig {
  code: string
  name: string
  appId: string | null
  secretId: string | null
  apiKey: string | null
  voiceId: string | null
  extra: Record<string, unknown>
}

/** 后台列表视图（Key 已掩码，不含明文） */
export interface TtsProviderView {
  id: string
  code: string
  name: string
  appId: string | null
  secretIdMasked: string | null
  apiKeyMasked: string | null
  voiceId: string | null
  extra: Record<string, unknown>
  enabled: boolean
  priority: number
  hasApiKey: boolean
}

type Row = {
  id: bigint
  code: string
  name: string
  appId: string | null
  secretIdEncrypted: Buffer | null
  apiKeyEncrypted: Buffer | null
  voiceId: string | null
  extraJson: unknown
  enabled: boolean
  priority: number
}

function toView(r: Row): TtsProviderView {
  const secretId = r.secretIdEncrypted ? decryptSecret(r.secretIdEncrypted) : null
  const apiKey = r.apiKeyEncrypted ? decryptSecret(r.apiKeyEncrypted) : null
  return {
    id: r.id.toString(),
    code: r.code,
    name: r.name,
    appId: r.appId,
    secretIdMasked: secretId ? maskSecret(secretId) : null,
    apiKeyMasked: apiKey ? maskSecret(apiKey) : null,
    voiceId: r.voiceId,
    extra: (r.extraJson ?? {}) as Record<string, unknown>,
    enabled: r.enabled,
    priority: r.priority,
    hasApiKey: !!apiKey,
  }
}

function toConfig(r: Row): TtsProviderConfig {
  return {
    code: r.code,
    name: r.name,
    appId: r.appId,
    secretId: r.secretIdEncrypted ? decryptSecret(r.secretIdEncrypted) : null,
    apiKey: r.apiKeyEncrypted ? decryptSecret(r.apiKeyEncrypted) : null,
    voiceId: r.voiceId,
    extra: (r.extraJson ?? {}) as Record<string, unknown>,
  }
}

export async function listTtsProviders(prisma: PrismaClient): Promise<TtsProviderView[]> {
  const rows = await prisma.ttsProvider.findMany({ orderBy: [{ enabled: 'desc' }, { priority: 'asc' }] })
  return rows.map((r) => toView(r as unknown as Row))
}

export async function getTtsProvider(prisma: PrismaClient, code: string): Promise<TtsProviderView | null> {
  const r = await prisma.ttsProvider.findUnique({ where: { code } })
  return r ? toView(r as unknown as Row) : null
}

export interface UpsertTtsProviderInput {
  code: string
  name?: string
  appId?: string | null
  /** 腾讯云 SecretId；留空/未传 = 保持不变，传空串 = 清除 */
  secretId?: string
  /** 主密钥：腾讯 SecretKey / 火山 AccessToken；留空/未传 = 保持不变，传空串 = 清除 */
  apiKey?: string
  voiceId?: string | null
  extra?: Record<string, unknown>
  enabled?: boolean
  priority?: number
}

export async function upsertTtsProvider(
  prisma: PrismaClient,
  input: UpsertTtsProviderInput,
): Promise<TtsProviderView> {
  const existing = await prisma.ttsProvider.findUnique({ where: { code: input.code } })

  // Key 语义：不传 = 保持原值；传非空串 = 覆盖；传空串 = 清除
  const secretIdEncrypted =
    input.secretId === undefined
      ? existing?.secretIdEncrypted
      : input.secretId === ''
        ? null
        : encryptSecret(input.secretId)
  const apiKeyEncrypted =
    input.apiKey === undefined
      ? existing?.apiKeyEncrypted
      : input.apiKey === ''
        ? null
        : encryptSecret(input.apiKey)

  const row = await prisma.ttsProvider.upsert({
    where: { code: input.code },
    create: {
      code: input.code,
      name: input.name ?? input.code,
      appId: input.appId ?? null,
      secretIdEncrypted: secretIdEncrypted ?? null,
      apiKeyEncrypted: apiKeyEncrypted ?? null,
      voiceId: input.voiceId ?? null,
      extraJson: (input.extra ?? {}) as object,
      enabled: input.enabled ?? false,
      priority: input.priority ?? 100,
    },
    update: {
      name: input.name ?? undefined,
      appId: input.appId ?? undefined,
      secretIdEncrypted: secretIdEncrypted ?? null,
      apiKeyEncrypted: apiKeyEncrypted ?? null,
      voiceId: input.voiceId ?? undefined,
      extraJson: input.extra ? (input.extra as object) : undefined,
      enabled: input.enabled ?? undefined,
      priority: input.priority ?? undefined,
    },
  })
  return toView(row as unknown as Row)
}

export async function setTtsEnabled(
  prisma: PrismaClient,
  code: string,
  enabled: boolean,
): Promise<TtsProviderView> {
  const row = await prisma.ttsProvider.update({ where: { code }, data: { enabled } })
  return toView(row as unknown as Row)
}

export async function removeTtsProvider(prisma: PrismaClient, code: string): Promise<void> {
  await prisma.ttsProvider.delete({ where: { code } })
}

/**
 * 运行时取「当前生效的配音供应商」：enabled 且已配置主密钥，按 priority 升序取第一个。
 * 未配置任何真实供应商时返回 null（合成链路退化为静音兜底）。
 */
export async function activeTtsProvider(prisma: PrismaClient): Promise<TtsProviderConfig | null> {
  const rows = await prisma.ttsProvider.findMany({
    where: { enabled: true, apiKeyEncrypted: { not: null } },
    orderBy: { priority: 'asc' },
  })
  const first = rows[0]
  return first ? toConfig(first as unknown as Row) : null
}
