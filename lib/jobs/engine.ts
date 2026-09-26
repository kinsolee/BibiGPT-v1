import { classifyUpstreamError } from '~/lib/models/errors'
import { isValidSummaryText } from '~/lib/jobs/validation'
import { JobError, JobRecord, JobSnapshot, JobStepRecord, SummaryJobParams } from '~/lib/jobs/types'
import { JobStore } from '~/lib/jobs/store'

export const DEFAULT_STEP_CONCURRENCY = Number(process.env.BIBI_JOB_STEP_CONCURRENCY) || 2
export const DEFAULT_STEP_TIMEOUT_MS = Number(process.env.BIBI_JOB_STEP_TIMEOUT_MS) || 300_000
export const DEFAULT_STEP_MAX_ATTEMPTS = Number(process.env.BIBI_JOB_STEP_MAX_ATTEMPTS) || 2
export const DEFAULT_STEP_BACKOFF_MS = Number(process.env.BIBI_JOB_STEP_BACKOFF_MS) || 2_500

/** 重试大概率无效的上游错误码：直接判死，不再消耗 attempt */
const NON_RETRYABLE_KINDS = new Set(['UPSTREAM_AUTH', 'MODEL_NOT_FOUND', 'CAPABILITY_UNSUPPORTED'])

export interface StepRunner {
  /** 单个 chunk 的 map 摘要；抛错代表该次 attempt 失败 */
  runChunk(params: SummaryJobParams, chunkIndex: number): Promise<string>
  /** 汇总 chunk 摘要生成全局 summary */
  runReduce(params: SummaryJobParams, chunkOutputs: string[]): Promise<string>
}

export interface JobEngineOptions {
  store: JobStore
  runner: StepRunner
  concurrency?: number
  stepTimeoutMs?: number
  stepMaxAttempts?: number
  stepBackoffMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export class JobFailureError extends Error {
  code: string
  status: 'failed' | 'canceled'

  constructor(code: string, message: string, status: 'failed' | 'canceled') {
    super(message)
    this.name = 'JobFailureError'
    this.code = code
    this.status = status
  }
}

class StepTimeoutError extends Error {
  code = 'TIMEOUT'
}

export function toJobError(error: unknown, stepIndex: number): JobError {
  if (error instanceof JobFailureError) {
    return { code: error.code, message: error.message, stepIndex }
  }
  const classified = classifyUpstreamError(error)
  return { code: classified.kind, message: classified.message, stepIndex }
}

function buildSteps(chunkCount: number, maxAttempts: number): JobStepRecord[] {
  const steps: JobStepRecord[] = Array.from({ length: chunkCount }, (_, index) => ({
    index,
    kind: 'chunk' as const,
    chunkIndex: index,
    chunkHash: null,
    status: 'queued',
    attempt: 0,
    maxAttempts,
    startedAt: null,
    finishedAt: null,
    error: null,
    output: '',
  }))
  steps.push({
    index: chunkCount,
    kind: 'reduce',
    chunkIndex: null,
    chunkHash: null,
    status: 'queued',
    attempt: 0,
    maxAttempts,
    startedAt: null,
    finishedAt: null,
    error: null,
    output: '',
  })
  return steps
}

/** 同进程内按 jobId 串行执行，避免并发请求对同一 job 重复调度 */
function createKeyedMutex() {
  const chains = new Map<string, Promise<unknown>>()
  return function keyed<T>(key: string, task: () => Promise<T>): Promise<T> {
    const next = (chains.get(key) ?? Promise.resolve()).then(task, task)
    const tail = next.catch(() => undefined)
    chains.set(key, tail)
    void tail.finally(() => {
      // 只有链尾仍是本次任务时才清理，防止误删后来者（同时避免 Map 无限增长）
      if (chains.get(key) === tail) {
        chains.delete(key)
      }
    })
    return next
  }
}

export class JobEngine {
  private readonly concurrency: number
  private readonly stepTimeoutMs: number
  private readonly stepMaxAttempts: number
  private readonly stepBackoffMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly jobLocks = createKeyedMutex()
  /** jobId → 取消标记；cancel() 置位后，运行循环在下一个检查点停下 */
  private readonly canceledJobs = new Set<string>()
  private readonly runningJobs = new Set<string>()

  private readonly options: JobEngineOptions

  constructor(options: JobEngineOptions) {
    this.options = options
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_STEP_CONCURRENCY)
    this.stepTimeoutMs = Math.max(1, options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS)
    this.stepMaxAttempts = Math.max(1, options.stepMaxAttempts ?? DEFAULT_STEP_MAX_ATTEMPTS)
    this.stepBackoffMs = Math.max(0, options.stepBackoffMs ?? DEFAULT_STEP_BACKOFF_MS)
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  async getJob(jobId: string): Promise<JobSnapshot | null> {
    const record = await this.options.store.loadJob(jobId)
    if (!record) {
      return null
    }
    const steps = (await this.options.store.loadSteps(jobId)) ?? []
    return { record, steps }
  }

  async listActiveJobs(): Promise<string[]> {
    return this.options.store.listActiveJobIds()
  }

  async listFailedJobs(olderThanMs?: number): Promise<string[]> {
    return this.options.store.listFailedJobIds(olderThanMs)
  }

  /** 失败队列清理：删除失败索引中（早于阈值的）job 记录，返回清理数量 */
  async cleanupFailedJobs(olderThanMs?: number): Promise<number> {
    const jobIds = await this.options.store.listFailedJobIds(olderThanMs)
    for (const jobId of jobIds) {
      await this.options.store.deleteJob(jobId)
    }
    return jobIds.length
  }

  /** 取消：不在执行中的 job 直接置终态；执行中的在步骤/重试间隙停下；幂等 */
  async cancel(jobId: string): Promise<boolean> {
    const snapshot = await this.getJob(jobId)
    if (!snapshot) {
      return false
    }
    if (this.runningJobs.has(jobId)) {
      this.canceledJobs.add(jobId)
      return true
    }
    if (snapshot.record.status === 'succeeded') {
      return false
    }
    if (snapshot.record.status === 'failed' || snapshot.record.status === 'canceled') {
      return true
    }
    await this.finalizeCanceled(snapshot)
    return true
  }

  /**
   * 幂等创建或续传一个摘要 job 并驱动到终态。
   * - succeeded：直接返回既有结果（reused=true），不再打 provider；重新生成需 forceNewResult
   * - queued/running/failed：从 checkpoint 续传（成功 chunk 的产出直接复用）
   * - 同进程并发请求同一 jobId：串行复用，第二个请求拿到 reused=true
   */
  async runSummaryJob(
    params: SummaryJobParams,
    digest: string,
    options: { forceNewResult?: boolean } = {},
  ): Promise<{ snapshot: JobSnapshot; reused: boolean }> {
    const jobId = `job_${digest}`
    return this.jobLocks(jobId, () => this.driveJob(jobId, digest, params, options.forceNewResult ?? false))
  }

  private async driveJob(
    jobId: string,
    digest: string,
    params: SummaryJobParams,
    forceNewResult: boolean,
  ): Promise<{ snapshot: JobSnapshot; reused: boolean }> {
    const store = this.options.store
    let record = await store.loadJob(jobId)
    let steps = await store.loadSteps(jobId)

    if (!record || !steps) {
      record = {
        id: jobId,
        digest,
        kind: 'summary',
        videoId: params.videoConfig.videoId,
        status: 'queued',
        attempt: 0,
        createdAt: this.now(),
        updatedAt: this.now(),
        startedAt: null,
        finishedAt: null,
        checkpoint: [],
        error: null,
        resultText: null,
        params,
      }
      steps = buildSteps(params.chunks.length, this.stepMaxAttempts)
      await store.saveJob(record)
      await store.saveSteps(jobId, steps)
      await store.addActiveIndex(jobId, record.createdAt)
    }

    // 幂等复用：已完成且未要求强制重新生成
    if (record.status === 'succeeded' && record.resultText && !forceNewResult) {
      return { snapshot: { record, steps }, reused: true }
    }

    this.canceledJobs.delete(jobId)
    this.runningJobs.add(jobId)
    try {
      await this.executeJob(jobId, record, steps)
    } finally {
      this.runningJobs.delete(jobId)
      this.canceledJobs.delete(jobId)
    }

    const finalRecord = await store.loadJob(jobId)
    const finalSteps = (await store.loadSteps(jobId)) ?? []
    if (!finalRecord) {
      throw new Error(`[jobs] job record vanished during execution: ${jobId}`)
    }
    return { snapshot: { record: finalRecord, steps: finalSteps }, reused: false }
  }

  private async executeJob(jobId: string, record: JobRecord, existingSteps: JobStepRecord[]) {
    const store = this.options.store
    const params = record.params

    const chunkSteps = existingSteps.filter((step) => step.kind === 'chunk')
    const resumedChunkCount = chunkSteps.filter((step) => step.status === 'succeeded' && step.output).length

    // 续传准备：成功且带产出的步骤原样保留（checkpoint），其余回 queued 重新计数
    let steps = existingSteps.map((step) => {
      if (step.status === 'succeeded' && step.output) {
        return step
      }
      return {
        ...step,
        status: 'queued' as const,
        attempt: 0,
        startedAt: null,
        finishedAt: null,
        error: null,
        output: '',
      }
    })

    let working: JobRecord = {
      ...record,
      status: 'running',
      attempt: record.attempt + 1,
      startedAt: this.now(),
      finishedAt: null,
      error: null,
      updatedAt: this.now(),
    }
    await store.saveJob(working)
    await store.saveSteps(jobId, steps)
    await store.removeFailedIndex(jobId)

    const persistStep = async (index: number, patch: Partial<JobStepRecord>) => {
      steps = steps.map((step) => (step.index === index ? { ...step, ...patch } : step))
      await store.saveSteps(jobId, steps)
    }
    const persistJob = async () => {
      const succeededChunks = steps
        .filter((step) => step.kind === 'chunk' && step.status === 'succeeded')
        .map((step) => step.chunkIndex!)
      working = { ...working, checkpoint: succeededChunks, updatedAt: this.now() }
      await store.saveJob(working)
    }

    // ---- map：worker pool 并行执行 chunk 摘要，并发不超上限 ----
    const pendingIndexes = steps.filter((step) => step.kind === 'chunk' && step.status === 'queued').map((s) => s.index)
    let cursor = 0
    // 持有对象避免 TS 控制流把闭包内赋值的 failure 收窄为 null
    const runState: { failure: JobError | null } = { failure: null }

    const worker = async () => {
      while (!runState.failure && !this.canceledJobs.has(jobId)) {
        const claimed = cursor
        cursor += 1
        if (claimed >= pendingIndexes.length) {
          return
        }
        const stepIndex = pendingIndexes[claimed]
        const step = steps.find((candidate) => candidate.index === stepIndex)!
        try {
          await this.runStepWithRetries(jobId, step, params, async (patch) => {
            await persistStep(step.index, patch)
            if (patch.status === 'succeeded') {
              await persistJob()
            }
          })
        } catch (error) {
          runState.failure = toJobError(error, step.index)
          return
        }
      }
    }
    await Promise.all(Array.from({ length: this.concurrency }, () => worker()))

    if (this.canceledJobs.has(jobId)) {
      const snapshot = await this.getJob(jobId)
      if (snapshot) {
        await this.finalizeCanceled(snapshot)
      }
      throw new JobFailureError('CANCELED', 'job canceled by user', 'canceled')
    }
    if (runState.failure) {
      await this.finalizeFailed(jobId, runState.failure)
      throw new JobFailureError(runState.failure.code, runState.failure.message, 'failed')
    }

    // ---- reduce：合并全部 chunk 摘要（若上次运行已完成 reduce 则直接复用） ----
    const chunkOutputs = steps
      .filter((step) => step.kind === 'chunk')
      .sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0))
      .map((step) => step.output)
    let reduceStep = steps.find((step) => step.kind === 'reduce')!
    if (!(reduceStep.status === 'succeeded' && reduceStep.output)) {
      try {
        await this.runStepWithRetries(
          jobId,
          reduceStep,
          params,
          async (patch) => {
            await persistStep(reduceStep.index, patch)
          },
          chunkOutputs,
        )
        reduceStep = steps.find((step) => step.kind === 'reduce')!
      } catch (error) {
        const jobError = toJobError(error, reduceStep.index)
        await this.finalizeFailed(jobId, jobError)
        throw new JobFailureError(jobError.code, jobError.message, 'failed')
      }
    }

    const done: JobRecord = {
      ...working,
      status: 'succeeded',
      checkpoint: steps.filter((step) => step.kind === 'chunk').map((step) => step.chunkIndex!),
      resultText: reduceStep.output,
      finishedAt: this.now(),
      updatedAt: this.now(),
      error: null,
    }
    await store.saveSteps(jobId, steps)
    await store.saveJob(done)
    await store.removeActiveIndex(jobId)
    return { resumedChunkCount }
  }

  /**
   * 单步骤执行：attempt 循环 + 超时 + 退避；非重试型错误立即失败。
   * fetchOpenAIResult 不支持注入 abortSignal，超时后该次 provider 调用被放弃
   * 不再等待（结果忽略、缓存写入幂等无害）；在途请求数受并发上限约束。
   */
  private async runStepWithRetries(
    jobId: string,
    step: JobStepRecord,
    params: SummaryJobParams,
    commit: (patch: Partial<JobStepRecord>) => Promise<void>,
    chunkOutputs?: string[],
  ) {
    const label = step.kind === 'chunk' ? `chunk#${step.chunkIndex}` : 'reduce'
    const maxAttempts = step.maxAttempts || this.stepMaxAttempts
    let attempt = 0

    while (attempt < maxAttempts) {
      attempt += 1
      await commit({ status: 'running', attempt, startedAt: this.now(), error: null })
      try {
        const promise =
          step.kind === 'chunk'
            ? this.options.runner.runChunk(params, step.chunkIndex!)
            : this.options.runner.runReduce(params, chunkOutputs ?? [])
        const raw = await this.withTimeout(promise)
        const text = typeof raw === 'string' ? raw.trim() : ''
        if (!isValidSummaryText(text)) {
          throw new JobFailureError(
            'PROVIDER_ERROR_PAGE',
            'provider returned empty or non-summary content (HTML error page?)',
            'failed',
          )
        }
        await commit({ status: 'succeeded', output: text, finishedAt: this.now(), error: null })
        return
      } catch (error) {
        const jobError = toJobError(error, step.index)
        const classified = classifyUpstreamError(error)
        const retryable =
          !NON_RETRYABLE_KINDS.has(classified.kind) &&
          jobError.code !== 'PROVIDER_ERROR_PAGE' &&
          jobError.code !== 'CANCELED'
        if (attempt >= maxAttempts || !retryable) {
          await commit({ status: 'failed', error: jobError, finishedAt: this.now() })
          if (error instanceof JobFailureError) {
            throw error
          }
          throw new JobFailureError(jobError.code, jobError.message, 'failed')
        }
        console.warn(
          `[jobs] ${jobId} ${label} attempt ${attempt}/${maxAttempts} failed (${jobError.code}), retrying in ${
            this.stepBackoffMs * attempt
          }ms`,
        )
        await commit({ status: 'queued', error: jobError })
        await this.sleep(this.stepBackoffMs * attempt)
      }
    }
    throw new JobFailureError('STEP_FAILED', `${label} exhausted attempts`, 'failed')
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new StepTimeoutError(`step timed out after ${this.stepTimeoutMs}ms`)),
        this.stepTimeoutMs,
      )
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  private async finalizeCanceled(snapshot: JobSnapshot) {
    const { record, steps } = snapshot
    const nextSteps = steps.map((step) =>
      step.status === 'succeeded' ? step : { ...step, status: 'canceled' as const, finishedAt: this.now() },
    )
    const nextRecord: JobRecord = {
      ...record,
      status: 'canceled',
      finishedAt: this.now(),
      updatedAt: this.now(),
      error: record.error ?? { code: 'CANCELED', message: 'canceled by user' },
    }
    await this.options.store.saveSteps(record.id, nextSteps)
    await this.options.store.saveJob(nextRecord)
    await this.options.store.removeActiveIndex(record.id)
  }

  private async finalizeFailed(jobId: string, error: JobError) {
    const snapshot = await this.getJob(jobId)
    if (!snapshot) {
      return
    }
    const steps = snapshot.steps.map((step) =>
      step.status === 'succeeded' || step.status === 'failed'
        ? step
        : { ...step, status: 'failed' as const, finishedAt: this.now(), error: step.error ?? error },
    )
    const record: JobRecord = {
      ...snapshot.record,
      status: 'failed',
      error,
      finishedAt: this.now(),
      updatedAt: this.now(),
    }
    await this.options.store.saveSteps(jobId, steps)
    await this.options.store.saveJob(record)
    await this.options.store.removeActiveIndex(jobId)
    await this.options.store.addFailedIndex(jobId, record.updatedAt)
  }
}
