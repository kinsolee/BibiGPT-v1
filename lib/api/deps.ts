import type { SupabaseClient } from '@supabase/supabase-js'
import { V1Error } from './errors'
import { getIdempotencyStore } from './idempotency'
import type { IdempotencyStore } from './idempotency'
import { getV1RateLimiter } from './ratelimit'
import type { RateLimiter } from './ratelimit'
import { getServiceSupabase } from './supabaseService'
import { createSupabaseApiTokenStore } from './tokenStore'
import type { ApiTokenStore } from './tokenStore'

export interface V1Deps {
  supabase: SupabaseClient | null
  tokenStore: ApiTokenStore
  rateLimiter: RateLimiter
  idempotencyStore: IdempotencyStore
}

/** Supabase 未配置时的占位 store：任何查找都以结构化 500 失败（部署配置错误） */
function createUnavailableApiTokenStore(): ApiTokenStore {
  const unavailable = (): never => {
    throw new V1Error('INTERNAL', 'api token store unavailable: set SUPABASE_SERVICE_ROLE_KEY to enable /api/v1 auth')
  }
  return {
    findByTokenHash: unavailable,
    touchLastUsed: () => undefined,
    create: unavailable,
    revoke: unavailable,
    list: unavailable,
  }
}

export function getV1Deps(): V1Deps {
  const supabase = getServiceSupabase()
  return {
    supabase,
    tokenStore: supabase ? createSupabaseApiTokenStore(supabase) : createUnavailableApiTokenStore(),
    rateLimiter: getV1RateLimiter(),
    idempotencyStore: getIdempotencyStore(),
  }
}
