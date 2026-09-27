import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

export const DEFAULT_V1_RATE_LIMIT_PER_MINUTE = 120

export interface V1RateLimitResult {
  success: boolean
  retryAfterSeconds?: number
}

/** 按 token（或任意 key）限流；失败即拒绝并给出建议重试秒数 */
export interface RateLimiter {
  limit(key: string): Promise<V1RateLimitResult>
}

/** 内存固定窗口实现：本地开发/fixture 注入用，进程重启即清零 */
export function createMemoryRateLimiter(maxPerMinute: number, windowMs = 60_000): RateLimiter {
  const windows = new Map<string, { windowStart: number; count: number }>()
  return {
    async limit(key) {
      const now = Date.now()
      const current = windows.get(key)
      if (!current || now - current.windowStart >= windowMs) {
        windows.set(key, { windowStart: now, count: 1 })
        if (windows.size > 10_000) {
          windows.forEach((value, key) => {
            if (now - value.windowStart >= windowMs) {
              windows.delete(key)
            }
          })
        }
        return { success: true, retryAfterSeconds: undefined }
      }
      if (current.count >= maxPerMinute) {
        const retryAfterSeconds = Math.max(1, Math.ceil((current.windowStart + windowMs - now) / 1000))
        return { success: false, retryAfterSeconds }
      }
      current.count += 1
      return { success: true, retryAfterSeconds: undefined }
    },
  }
}

/** Upstash 固定窗口实现：与 lib/upstash.ts 的 Ratelimit 用法一致（多实例部署下窗口共享） */
export function createUpstashRateLimiter(redis: Redis, maxPerMinute: number): RateLimiter {
  const ratelimit = new Ratelimit({
    redis,
    limiter: Ratelimit.fixedWindow(maxPerMinute, '1 m'),
    prefix: 'bibi:v1:ratelimit',
  })
  return {
    async limit(key) {
      const result = await ratelimit.limit(key)
      const reset = typeof (result as { reset?: unknown }).reset === 'number' ? (result as { reset: number }).reset : 0
      const retryAfterSeconds = reset > Date.now() ? Math.max(1, Math.ceil((reset - Date.now()) / 1000)) : undefined
      return { success: result.success, retryAfterSeconds }
    },
  }
}

/** 默认实现：配置了 UPSTASH_RATE_* 用 Upstash，否则退化为进程内存窗口 */
export function getV1RateLimiter(): RateLimiter {
  const max = Number(process.env.BIBI_V1_RATE_LIMIT_PER_MINUTE) || DEFAULT_V1_RATE_LIMIT_PER_MINUTE
  const url = process.env.UPSTASH_RATE_REDIS_REST_URL
  const token = process.env.UPSTASH_RATE_REDIS_REST_TOKEN
  if (url && token) {
    return createUpstashRateLimiter(new Redis({ url, token }), max)
  }
  return createMemoryRateLimiter(max)
}
