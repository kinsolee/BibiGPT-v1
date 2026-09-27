import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

let cached: SupabaseClient | null | undefined

/**
 * v1 API 专用 service role client：api_tokens 哈希查找与按 token.user_id
 * 显式隔离的业务查询都走它（RLS 面向 cookie 会话，Bearer token 场景没有
 * Supabase JWT）。未配置 SUPABASE_SERVICE_ROLE_KEY 时返回 null，
 * 由调用方决定降级行为（auth 查找 → 500 结构化错误）。
 */
export function getServiceSupabase(): SupabaseClient | null {
  if (cached !== undefined) {
    return cached
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    console.error('[v1] SUPABASE_SERVICE_ROLE_KEY not configured; DB-backed /api/v1 endpoints are unavailable')
    cached = null
    return cached
  }
  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return cached
}
