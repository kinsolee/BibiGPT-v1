import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sha256Hex } from '~/lib/history/hash'

export type V1TokenScope = 'read' | 'write'

export interface V1TokenRecord {
  id: string
  userId: string
  scope: V1TokenScope
  name: string
  revoked: boolean
}

export interface ApiTokenListItem extends V1TokenRecord {
  createdAt: string
  lastUsedAt: string | null
}

export interface ApiTokenCreateResult {
  token: string
  record: ApiTokenListItem
}

/**
 * v1 API token 存取。查找走 sha256 哈希等值匹配（数据库 unique 索引），
 * 明文 token 只在 create 时返回一次。
 */
export interface ApiTokenStore {
  findByTokenHash(tokenHash: string): Promise<V1TokenRecord | null>
  /** fire-and-forget 更新 last_used_at（实现内部自带节流） */
  touchLastUsed(tokenId: string): void
  create(input: { userId: string; scope: V1TokenScope; name?: string }): Promise<ApiTokenCreateResult>
  revoke(tokenId: string): Promise<boolean>
  list(): Promise<ApiTokenListItem[]>
}

export const API_TOKEN_PREFIX = 'bvt_'

export function generateApiToken(): string {
  return `${API_TOKEN_PREFIX}${randomBytes(24).toString('hex')}`
}

export function hashApiToken(token: string): Promise<string> {
  return sha256Hex(token)
}

interface ApiTokenRow {
  id: string
  user_id: string
  token_hash: string
  name: string
  scope: string
  revoked: boolean
  created_at: string
  last_used_at: string | null
}

function toRecord(row: ApiTokenRow): V1TokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    scope: row.scope === 'write' ? 'write' : 'read',
    name: row.name ?? '',
    revoked: Boolean(row.revoked),
  }
}

function toListItem(row: ApiTokenRow): ApiTokenListItem {
  return {
    ...toRecord(row),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
  }
}

/** last_used_at 更新节流：同一 token 一分钟内最多写一次，避免高频读放大写压力 */
const lastTouchAt = new Map<string, number>()
const TOUCH_THROTTLE_MS = 60_000

export function createSupabaseApiTokenStore(supabase: SupabaseClient): ApiTokenStore {
  return {
    async findByTokenHash(tokenHash) {
      const { data, error } = await supabase
        .from('api_tokens')
        .select('id, user_id, token_hash, name, scope, revoked, created_at, last_used_at')
        .eq('token_hash', tokenHash)
        .maybeSingle()
      if (error) {
        throw error
      }
      return data ? toRecord(data as ApiTokenRow) : null
    },
    touchLastUsed(tokenId) {
      const now = Date.now()
      const previous = lastTouchAt.get(tokenId) ?? 0
      if (now - previous < TOUCH_THROTTLE_MS) {
        return
      }
      lastTouchAt.set(tokenId, now)
      void supabase
        .from('api_tokens')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', tokenId)
        .then(
          ({ error }) => {
            if (error) {
              console.error(`[v1] touch last_used_at failed for token ${tokenId}: ${error.message}`)
            }
          },
          (error: unknown) => {
            console.error(`[v1] touch last_used_at failed for token ${tokenId}: ${String(error)}`)
          },
        )
    },
    async create({ userId, scope, name }) {
      const token = generateApiToken()
      const tokenHash = await hashApiToken(token)
      const { data, error } = await supabase
        .from('api_tokens')
        .insert({ user_id: userId, token_hash: tokenHash, name: name ?? '', scope })
        .select('id, user_id, token_hash, name, scope, revoked, created_at, last_used_at')
        .single()
      if (error) {
        throw error
      }
      return { token, record: toListItem(data as ApiTokenRow) }
    },
    async revoke(tokenId) {
      const { data, error } = await supabase.from('api_tokens').update({ revoked: true }).eq('id', tokenId).select('id')
      if (error) {
        throw error
      }
      return (data?.length ?? 0) > 0
    },
    async list() {
      const { data, error } = await supabase
        .from('api_tokens')
        .select('id, user_id, token_hash, name, scope, revoked, created_at, last_used_at')
        .order('created_at', { ascending: false })
      if (error) {
        throw error
      }
      return ((data ?? []) as ApiTokenRow[]).map(toListItem)
    },
  }
}
