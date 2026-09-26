import { Redis } from '@upstash/redis'

import { JobRecord, JobStepRecord } from '~/lib/jobs/types'

const KEY_PREFIX = 'bibi:job:v1'
const KEY_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * REST client 开启 automaticDeserialization 时 get 可能已把 JSON 反序列化成对象，
 * 关闭时返回原始字符串；两种形态都要能读。
 */
function parseStoredRecord<T>(raw: unknown, jobId: string): T | null {
  if (!raw) {
    return null
  }
  if (typeof raw !== 'string') {
    return raw as T
  }
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    console.error(`[jobs] corrupt stored record ${jobId}:`, error)
    return null
  }
}

export interface JobStore {
  loadJob(jobId: string): Promise<JobRecord | null>
  saveJob(record: JobRecord): Promise<void>
  loadSteps(jobId: string): Promise<JobStepRecord[] | null>
  saveSteps(jobId: string, steps: JobStepRecord[]): Promise<void>
  deleteJob(jobId: string): Promise<void>
  /** 记录未到终态的 job（zset，score=createdAt ms），供巡检与清理 */
  addActiveIndex(jobId: string, createdAtMs: number): Promise<void>
  removeActiveIndex(jobId: string): Promise<void>
  listActiveJobIds(): Promise<string[]>
  /** 失败队列索引（zset，score=updatedAt ms） */
  addFailedIndex(jobId: string, updatedAtMs: number): Promise<void>
  removeFailedIndex(jobId: string): Promise<void>
  listFailedJobIds(olderThanMs?: number): Promise<string[]>
  /**
   * 跨实例 job 执行锁（lease）：同一 jobId 同时只允许一个持有者驱动执行。
   * 返回 false 表示已被其它实例持有；TTL 兜底防止持有者崩溃后死锁。
   */
  acquireJobLock(jobId: string, holderId: string, ttlMs: number): Promise<boolean>
  /** 只有当前持有者能释放（防误删他人锁）；非持有者调用为 no-op */
  releaseJobLock(jobId: string, holderId: string): Promise<void>
  /** 续约：仅当锁仍由该持有者持有时刷新 TTL；已被抢走/过期返回 false */
  renewJobLock(jobId: string, holderId: string, ttlMs: number): Promise<boolean>
  /** 是否有实例持有该 job 的执行锁（含 TTL 未过期的判断） */
  hasJobLock(jobId: string): Promise<boolean>
  /** 取消请求落共享存储：跨实例的 worker 在步骤检查点读取并兑现 */
  requestCancel(jobId: string): Promise<void>
  isCancelRequested(jobId: string): Promise<boolean>
  /** job 到终态后清取消标志 */
  clearCancelFlag(jobId: string): Promise<void>
}

/** 开发/测试用内存实现；export 以便 fixture 注入 */
export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, JobRecord>()
  private steps = new Map<string, JobStepRecord[]>()
  private active = new Map<string, number>()
  private failed = new Map<string, number>()
  private locks = new Map<string, { holderId: string; expiresAtMs: number }>()
  private cancelFlags = new Set<string>()

  async loadJob(jobId: string) {
    return this.jobs.get(jobId) ?? null
  }

  async saveJob(record: JobRecord) {
    this.jobs.set(record.id, record)
  }

  async loadSteps(jobId: string) {
    return this.steps.get(jobId) ?? null
  }

  async saveSteps(jobId: string, steps: JobStepRecord[]) {
    this.steps.set(jobId, steps)
  }

  async deleteJob(jobId: string) {
    this.jobs.delete(jobId)
    this.steps.delete(jobId)
    this.active.delete(jobId)
    this.failed.delete(jobId)
  }

  async addActiveIndex(jobId: string, createdAtMs: number) {
    this.active.set(jobId, createdAtMs)
  }

  async removeActiveIndex(jobId: string) {
    this.active.delete(jobId)
  }

  async listActiveJobIds() {
    return Array.from(this.active.keys())
  }

  async addFailedIndex(jobId: string, updatedAtMs: number) {
    this.failed.set(jobId, updatedAtMs)
  }

  async removeFailedIndex(jobId: string) {
    this.failed.delete(jobId)
  }

  async listFailedJobIds(olderThanMs?: number) {
    return Array.from(this.failed.entries())
      .filter(([, updatedAt]) => olderThanMs === undefined || updatedAt <= olderThanMs)
      .map(([jobId]) => jobId)
  }

  async acquireJobLock(jobId: string, holderId: string, ttlMs: number) {
    const now = Date.now()
    const existing = this.locks.get(jobId)
    if (existing && existing.holderId !== holderId && existing.expiresAtMs > now) {
      return false
    }
    this.locks.set(jobId, { holderId, expiresAtMs: now + ttlMs })
    return true
  }

  async releaseJobLock(jobId: string, holderId: string) {
    const existing = this.locks.get(jobId)
    if (existing?.holderId === holderId) {
      this.locks.delete(jobId)
    }
  }

  async hasJobLock(jobId: string) {
    const existing = this.locks.get(jobId)
    return Boolean(existing && existing.expiresAtMs > Date.now())
  }

  async renewJobLock(jobId: string, holderId: string, ttlMs: number) {
    const existing = this.locks.get(jobId)
    if (!existing || existing.holderId !== holderId) {
      return false
    }
    existing.expiresAtMs = Date.now() + ttlMs
    return true
  }

  async requestCancel(jobId: string) {
    this.cancelFlags.add(jobId)
  }

  async isCancelRequested(jobId: string) {
    return this.cancelFlags.has(jobId)
  }

  async clearCancelFlag(jobId: string) {
    this.cancelFlags.delete(jobId)
  }
}

class UpstashJobStore implements JobStore {
  private readonly redis: Redis

  constructor(redis: Redis) {
    this.redis = redis
  }

  private jobKey(jobId: string) {
    return `${KEY_PREFIX}:job:${jobId}`
  }

  private stepsKey(jobId: string) {
    return `${KEY_PREFIX}:steps:${jobId}`
  }

  private lockKey(jobId: string) {
    return `${KEY_PREFIX}:lock:${jobId}`
  }

  async loadJob(jobId: string): Promise<JobRecord | null> {
    const raw = await this.redis.get<unknown>(this.jobKey(jobId))
    return parseStoredRecord<JobRecord>(raw, jobId)
  }

  async saveJob(record: JobRecord) {
    await this.redis.set(this.jobKey(record.id), JSON.stringify(record), { ex: KEY_TTL_SECONDS })
  }

  async loadSteps(jobId: string): Promise<JobStepRecord[] | null> {
    const raw = await this.redis.get<unknown>(this.stepsKey(jobId))
    return parseStoredRecord<JobStepRecord[]>(raw, jobId)
  }

  async saveSteps(jobId: string, steps: JobStepRecord[]) {
    await this.redis.set(this.stepsKey(jobId), JSON.stringify(steps), { ex: KEY_TTL_SECONDS })
  }

  async deleteJob(jobId: string) {
    await this.redis.del(this.jobKey(jobId), this.stepsKey(jobId))
    await this.removeActiveIndex(jobId)
    await this.removeFailedIndex(jobId)
  }

  async addActiveIndex(jobId: string, createdAtMs: number) {
    await this.redis.zadd(`${KEY_PREFIX}:index:active`, { score: createdAtMs, member: jobId })
  }

  async removeActiveIndex(jobId: string) {
    await this.redis.zrem(`${KEY_PREFIX}:index:active`, jobId)
  }

  async listActiveJobIds() {
    return (await this.redis.zrange(`${KEY_PREFIX}:index:active`, 0, -1)) as string[]
  }

  async addFailedIndex(jobId: string, updatedAtMs: number) {
    await this.redis.zadd(`${KEY_PREFIX}:index:failed`, { score: updatedAtMs, member: jobId })
  }

  async removeFailedIndex(jobId: string) {
    await this.redis.zrem(`${KEY_PREFIX}:index:failed`, jobId)
  }

  async listFailedJobIds(olderThanMs?: number) {
    if (olderThanMs === undefined) {
      return (await this.redis.zrange(`${KEY_PREFIX}:index:failed`, 0, -1)) as string[]
    }
    return (await this.redis.zrange(`${KEY_PREFIX}:index:failed`, 0, olderThanMs, { byScore: true })) as string[]
  }

  async acquireJobLock(jobId: string, holderId: string, ttlMs: number) {
    const result = await this.redis.set(this.lockKey(jobId), holderId, { nx: true, px: ttlMs })
    return result === 'OK'
  }

  async releaseJobLock(jobId: string, holderId: string) {
    // GET+DEL 非原子，但错删窗口极小且有 TTL 兜底；自用版足够。
    // 持有者崩溃时锁靠 TTL 自动过期，不会死锁。
    const current = await this.redis.get<string>(this.lockKey(jobId))
    if (current === holderId) {
      await this.redis.del(this.lockKey(jobId))
    }
  }

  async hasJobLock(jobId: string) {
    return (await this.redis.exists(this.lockKey(jobId))) > 0
  }

  async renewJobLock(jobId: string, holderId: string, ttlMs: number) {
    // 原子续约：锁仍属于该持有者才刷新 TTL，防止过期后被他人抢走时误续
    const script = `if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("set", KEYS[1], ARGV[1], "PX", ARGV[2])
end
return 0`
    const result = await this.redis.eval<string[], unknown>(script, [this.lockKey(jobId)], [holderId, String(ttlMs)])
    return result === 'OK'
  }

  private cancelKey(jobId: string) {
    return `${KEY_PREFIX}:cancel:${jobId}`
  }

  async requestCancel(jobId: string) {
    await this.redis.set(this.cancelKey(jobId), '1', { ex: KEY_TTL_SECONDS })
  }

  async isCancelRequested(jobId: string) {
    const value = await this.redis.get<unknown>(this.cancelKey(jobId))
    return value !== null && value !== undefined
  }

  async clearCancelFlag(jobId: string) {
    await this.redis.del(this.cancelKey(jobId))
  }
}

let defaultStore: JobStore | null = null

/** 生产默认：Upstash；未配置 Redis 时退化为内存 store（job 不跨重启，仅当次请求内有效） */
export function getDefaultJobStore(): JobStore {
  if (!defaultStore) {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
      defaultStore = new UpstashJobStore(Redis.fromEnv())
    } else {
      console.warn('[jobs] UPSTASH_REDIS_REST_URL/TOKEN missing, jobs fall back to in-memory store')
      defaultStore = new MemoryJobStore()
    }
  }
  return defaultStore
}
