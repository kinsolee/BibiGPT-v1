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
}

/** 开发/测试用内存实现；export 以便 fixture 注入 */
export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, JobRecord>()
  private steps = new Map<string, JobStepRecord[]>()
  private active = new Map<string, number>()
  private failed = new Map<string, number>()

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
