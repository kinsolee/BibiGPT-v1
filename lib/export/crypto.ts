// KIN-47 导出侧加密与签名：
//  * AES-256-GCM 加密 webhook/API secret（存储格式 enc:v1:base64(iv|tag|ct)）
//  * HMAC 签名的下载 URL token（携带 contentId/format/userId/exp）
// 主密钥来自 EXPORT_SECRET_KEY（任意长字符串，内部 sha256 派生 32B）。
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { ExportError } from './errors'

const ENC_PREFIX = 'enc:v1:'
const IV_BYTES = 12
const TAG_BYTES = 16

function loadKey(keyOverride?: string): Buffer {
  const secret = keyOverride ?? process.env.EXPORT_SECRET_KEY
  if (!secret || secret.length < 16) {
    throw new ExportError('export_secret_missing', 500, 'EXPORT_SECRET_KEY 未配置或过短（至少 16 字符）')
  }
  return createHash('sha256').update(secret, 'utf8').digest()
}

export function encryptSecret(plaintext: string, keyOverride?: string): string {
  const key = loadKey(keyOverride)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ENC_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

export function decryptSecret(blob: string, keyOverride?: string): string {
  const key = loadKey(keyOverride)
  if (!blob.startsWith(ENC_PREFIX)) {
    throw new ExportError('secret_blob_invalid', 500, '加密配置格式不合法')
  }
  const raw = Buffer.from(blob.slice(ENC_PREFIX.length), 'base64')
  if (raw.length <= IV_BYTES + TAG_BYTES) {
    throw new ExportError('secret_blob_invalid', 500, '加密配置长度不合法')
  }
  const iv = raw.subarray(0, IV_BYTES)
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

export type DownloadTokenPayload = {
  contentId: string
  format: string
  userId: string
  /** 过期时间（epoch ms） */
  exp: number
}

function tokenString(payload: DownloadTokenPayload): string {
  return `c=${payload.contentId}&f=${payload.format}&u=${payload.userId}&e=${payload.exp}`
}

export function signDownloadToken(payload: DownloadTokenPayload, keyOverride?: string): string {
  const key = loadKey(keyOverride)
  return createHmac('sha256', key).update(tokenString(payload)).digest('base64url')
}

export function verifyDownloadToken(payload: DownloadTokenPayload, signature: string, keyOverride?: string): boolean {
  const expected = signDownloadToken(payload, keyOverride)
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) {
    return false
  }
  if (payload.exp < Date.now()) {
    return false
  }
  return timingSafeEqual(a, b)
}

export function buildDownloadUrl(baseUrl: string, payload: DownloadTokenPayload, keyOverride?: string): string {
  const signature = signDownloadToken(payload, keyOverride)
  const params = new URLSearchParams({
    c: payload.contentId,
    f: payload.format,
    u: payload.userId,
    e: String(payload.exp),
    s: signature,
  })
  return `${baseUrl}?${params.toString()}`
}

export function parseDownloadToken(query: {
  c?: string | string[]
  f?: string | string[]
  u?: string | string[]
  e?: string | string[]
  s?: string | string[]
}): { payload: DownloadTokenPayload; signature: string } | null {
  const contentId = typeof query.c === 'string' ? query.c : null
  const format = typeof query.f === 'string' ? query.f : null
  const userId = typeof query.u === 'string' ? query.u : null
  const expRaw = typeof query.e === 'string' ? query.e : null
  const signature = typeof query.s === 'string' ? query.s : null
  if (!contentId || !format || !userId || !expRaw || !signature) {
    return null
  }
  const exp = Number(expRaw)
  if (!Number.isFinite(exp)) {
    return null
  }
  return { payload: { contentId, format, userId, exp }, signature }
}
