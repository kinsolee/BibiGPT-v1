import { Redis } from '@upstash/redis'
import { sha256Hex, stableStringify } from '~/lib/history/hash'

export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600

export interface IdempotencyRecord {
  /** 请求体的稳定哈希：同 key 不同 body 判 409 IDEMPOTENCY_CONFLICT */
  bodyHash: string
  httpStatus: number
  body: unknown
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>
  set(key: string, record: IdempotencyRecord): Promise<void>
}

/** 内存实现：单进程开发/fixture 注入用 */
export function createMemoryIdempotencyStore(ttlSeconds = IDEMPOTENCY_TTL_SECONDS): IdempotencyStore {
  const entries = new Map<string, { record: IdempotencyRecord; expiresAt: number }>()
  const prune = (now: number) => {
    entries.forEach((value, key) => {
      if (value.expiresAt <= now) {
        entries.delete(key)
      }
    })
  }
  return {
    async get(key) {
      const now = Date.now()
      const hit = entries.get(key)
      if (!hit) {
        return null
      }
      if (hit.expiresAt <= now) {
        entries.delete(key)
        return null
      }
      return hit.record
    },
    async set(key, record) {
      prune(Date.now())
      entries.set(key, { record, expiresAt: Date.now() + ttlSeconds * 1000 })
    },
  }
}

/** Upstash 实现 forKey `bibi:v1:idem:{route}:{tokenId}:{key}`，TTL 24h */
export function createUpstashIdempotencyStore(redis: Redis, ttlSeconds = IDEMPOTENCY_TTL_SECONDS): IdempotencyStore {
  return {
    async get(key) {
      const hit = await redis.get<IdempotencyRecord>(`bibi:v1:idem:${key}`)
      return hit ?? null
    },
    async set(key, record) {
      await redis.set(`bibi:v1:idem:${key}`, record, { ex: ttlSeconds })
    },
  }
}

/** 默认实现：配置了数据 Redis（UPSTASH_REDIS_REST_*）用 Upstash，否则内存 */
export function getIdempotencyStore(): IdempotencyStore {
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (url && token) {
    return createUpstashIdempotencyStore(new Redis({ url, token }))
  }
  return createMemoryIdempotencyStore()
}

/** 请求体指纹：KIN-42 的教训——sha256Hex 是 async（WebCrypto），必须 await */
export async function requestBodyHash(body: unknown): Promise<string> {
  return sha256Hex(stableStringify(body ?? null))
}
