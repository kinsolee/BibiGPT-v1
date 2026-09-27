import { Redis } from '@upstash/redis'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * job 归属登记（v1 层封装，不改 lib/jobs/**）：
 * job digest 不含用户标识，同源同配置跨用户共享同一 jobId，因此
 * GET /api/v1/jobs/{id} 必须校验「该用户通过 v1 提交过此 job」。
 * - 配置了数据 Redis：SADD `bibi:v1:jobusers:{jobId}`（TTL 与 job store 7 天对齐）
 * - 未配置（本地单实例）：进程内 Map 兜底，与 MemoryJobStore 降级对称
 * 兜底：若 Redis 记录丢失（极端窗口），该用户 contents 表已有同源落库行同样放行。
 * 纯旧链路（/api/sumup）创建且从未经 v1 提交的 job 一律 404，不泄漏存在性。
 */

const OWNERSHIP_TTL_SECONDS = 7 * 24 * 3600
const MEMORY_MAX_ENTRIES = 5_000

interface MemoryOwnerEntry {
  owners: Set<string>
  expiresAt: number
}

const memoryOwners = new Map<string, MemoryOwnerEntry>()

let cachedRedis: Redis | null | undefined

function getRedis(): Redis | null {
  if (cachedRedis !== undefined) {
    return cachedRedis
  }
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  cachedRedis = url && token ? new Redis({ url, token }) : null
  return cachedRedis
}

function ownerKey(jobId: string): string {
  return `bibi:v1:jobusers:${jobId}`
}

function pruneMemory(now: number): void {
  if (memoryOwners.size <= MEMORY_MAX_ENTRIES) {
    return
  }
  memoryOwners.forEach((entry, key) => {
    if (entry.expiresAt <= now) {
      memoryOwners.delete(key)
    }
  })
}

/** submit（含复用命中）时登记访问权；fire-and-forget，失败仅记日志 */
export function recordJobOwner(jobId: string, userId: string): void {
  const redis = getRedis()
  if (redis) {
    void redis
      .sadd(ownerKey(jobId), userId)
      .then(() => redis.expire(ownerKey(jobId), OWNERSHIP_TTL_SECONDS))
      .catch((error: unknown) => {
        console.error(`[v1] record job owner failed for ${jobId}: ${String(error)}`)
      })
  }
  const now = Date.now()
  pruneMemory(now)
  const entry = memoryOwners.get(jobId)
  if (entry && entry.expiresAt > now) {
    entry.owners.add(userId)
    return
  }
  memoryOwners.set(jobId, { owners: new Set([userId]), expiresAt: now + OWNERSHIP_TTL_SECONDS * 1000 })
}

export interface JobOwnershipCheck {
  supabase: SupabaseClient | null
  jobId: string
  userId: string
  sourceKey: { service: string; sourceRef: string; sourcePage: string | null }
}

export async function isJobAccessible(input: JobOwnershipCheck): Promise<boolean> {
  const redis = getRedis()
  if (redis) {
    try {
      const member = await redis.sismember(ownerKey(input.jobId), input.userId)
      if (Number(member) === 1) {
        return true
      }
    } catch (error) {
      console.error(`[v1] job ownership lookup failed for ${input.jobId}: ${String(error)}`)
    }
  }
  const entry = memoryOwners.get(input.jobId)
  if (entry && entry.expiresAt > Date.now() && entry.owners.has(input.userId)) {
    return true
  }
  if (input.supabase) {
    let query = input.supabase
      .from('contents')
      .select('id')
      .eq('user_id', input.userId)
      .eq('service', input.sourceKey.service)
      .eq('source_ref', input.sourceKey.sourceRef)
    query =
      input.sourceKey.sourcePage === null
        ? query.is('source_page', null)
        : query.eq('source_page', input.sourceKey.sourcePage)
    const { data, error } = await query.maybeSingle()
    if (!error && data) {
      return true
    }
  }
  return false
}
