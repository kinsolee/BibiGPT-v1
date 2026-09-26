import { classifyUpstreamError } from '~/lib/models/errors'
import { isValidSummaryText } from '~/lib/jobs/validation'
import { JobError, JobRecord, JobSnapshot, JobStepRecord, SummaryJobParams } from '~/lib/jobs/types'
import { JobStore } from '~/lib/jobs/store'

export const DEFAULT_STEP_CONCURRENCY = Number(process.env.BIBI_JOB_STEP_CONCURRENCY) || 2
export const DEFAULT_STEP_TIMEOUT_MS = Number(process.env.BIBI_JOB_STEP_TIMEOUT_MS) || 300_000
export const DEFAULT_STEP_MAX_ATTEMPTS = Number(process.env.BIBI_JOB_STEP_MAX_ATTEMPTS) || 2
export const DEFAULT_STEP_BACKOFF_MS = Number(process.env.BIBI_JOB_STEP_BACKOFF_MS) || 2_500
/** 分布式锁 lease：需覆盖最长一次 job 执行；持有者崩溃时靠 TTL 自动过期 */
export const DEFAULT_JOB_LOCK_TTL_MS = Number(process.env.BIBI_JOB_LOCK_TTL_MS) || 30 * 60_000
/** 等锁上限：另一实例在跑同一 job 时，先等它完成以便直接复用结果 */
export const DEFAULT_JOB_LOCK_WAIT_MS = Number(process.env.BIBI_JOB_LOCK_WAIT_MS) || 90_000
const JOB_LOCK_RETRY_INTERVAL_MS = 1_000

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
  lockTtlMs?: number
  lockWaitMs?: number
  lockRetryIntervalMs?: number
  lockRenewIntervalMs?: number
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

/**
 * 持久化前剥离凭据（顶层 apiKey 与 userConfig.userKey）：
 * job record 会明文进 Redis（7 天 TTL），任何密钥都不能落盘；
 * 执行时由当次请求重新注入。
 */
function stripSecrets(params: SummaryJobParams): SummaryJobParams {
  return { ...params, apiKey: '', userConfig: { ...params.userConfig, userKey: undefined } }
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
  private readonly lockTtlMs: number
  private readonly lockWaitMs: number
  private readonly lockRetryIntervalMs: number
  private readonly lockRenewIntervalMs: number
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
    this.lockTtlMs = Math.max(1, options.lockTtlMs ?? DEFAULT_JOB_LOCK_TTL_MS)
    this.lockWaitMs = Math.max(0, options.lockWaitMs ?? DEFAULT_JOB_LOCK_WAIT_MS)
    this.lockRetryIntervalMs = Math.max(1, options.lockRetryIntervalMs ?? JOB_LOCK_RETRY_INTERVAL_MS)
    // 续约间隔默认取 TTL 的 1/3（下限 1s），超长 job 执行期间锁不会因 TTL 过期被抢
    this.lockRenewIntervalMs = Math.max(
      1,
      options.lockRenewIntervalMs ?? Math.max(1_000, Math.floor(this.lockTtlMs / 3)),
    )
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

  /**
   * 取消（跨实例）：把取消请求落入共享存储，持有锁的执行实例在步骤检查点
   * 读取并兑现（保证步骤写入者唯一，避免终态互相覆盖）。没有任何实例在执行
   * （无锁）时由本调用直接收尾终态。幂等。
   */
  async cancel(jobId: string): Promise<boolean> {
    const snapshot = await this.getJob(jobId)
    if (!snapshot) {
      return false
    }
    if (snapshot.record.status === 'succeeded') {
      return false
    }
    if (snapshot.record.status === 'failed' || snapshot.record.status === 'canceled') {
      return true
    }
    this.canceledJobs.add(jobId)
    try {
      await this.options.store.requestCancel(jobId)
    } catch (error) {
      // 共享标志写失败时退化为本地标志：本进程执行仍可兑现，跨实例尽力而为
      console.error(`[jobs] persist cancel flag failed for ${jobId}:`, error)
    }
    const runningHere = this.runningJobs.has(jobId)
    if (!runningHere && !(await this.options.store.hasJobLock(jobId).catch(() => false))) {
      await this.finalizeCanceled(snapshot)
      // 无 worker 直接收尾时必须清共享取消标志：否则后续同 digest 重启执行
      // 会在每个检查点命中过期标志被立即取消，job 直到 TTL 过期都不可跑
      await this.options.store.clearCancelFlag(jobId).catch(() => undefined)
    }
    return true
  }

  /** 步骤检查点统一走这里：本地标志或共享存储标志任一命中即视为取消 */
  private async checkCanceled(jobId: string): Promise<boolean> {
    if (this.canceledJobs.has(jobId)) {
      return true
    }
    try {
      if (await this.options.store.isCancelRequested(jobId)) {
        this.canceledJobs.add(jobId)
        return true
      }
    } catch (error) {
      // 标志读取失败按未取消处理（fail-open），下一检查点再试
      console.error(`[jobs] read cancel flag failed for ${jobId}:`, error)
    }
    return false
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
    let { record, steps } = await this.ensureJobRecord(jobId, digest, params)

    // 幂等复用：已完成且未要求强制重新生成
    if (record.status === 'succeeded' && record.resultText && !forceNewResult) {
      return { snapshot: { record, steps }, reused: true }
    }

    // 跨实例执行锁：拿到之前绝不修改 job 状态（拿不到锁时抛错不影响既有记录）
    const holderId = `${jobId}:${Math.random().toString(36).slice(2)}:${this.now()}`
    const lockOutcome = await this.acquireJobLockWithWait(jobId, holderId, forceNewResult)
    if (lockOutcome === 'completed') {
      // 等待期间另一实例已跑完：直接复用其结果
      const completedRecord = await store.loadJob(jobId)
      const completedSteps = (await store.loadSteps(jobId)) ?? []
      if (completedRecord) {
        return { snapshot: { record: completedRecord, steps: completedSteps }, reused: true }
      }
    }
    if (lockOutcome !== 'acquired') {
      throw new JobFailureError('JOB_LOCK_BUSY', `another instance is running job ${jobId}`, 'failed')
    }

    // 执行期间周期续约，防止超长 job 超过锁 TTL 后被第二实例抢入
    const renewTimer = setInterval(() => {
      void store
        .renewJobLock(jobId, holderId, this.lockTtlMs)
        .then((renewed) => {
          if (!renewed) {
            console.error(`[jobs] lock renew rejected for ${jobId} (lost lock?)`)
          }
        })
        .catch((error) => console.error(`[jobs] lock renew failed for ${jobId}:`, error))
    }, this.lockRenewIntervalMs)

    // 强制重新生成：清空全部已完成步骤与结果，回到全量重跑（在持锁后落盘）
    if (forceNewResult) {
      steps = buildSteps(params.chunks.length, this.stepMaxAttempts)
      record = {
        ...record,
        status: 'queued',
        resultText: null,
        checkpoint: [],
        error: null,
        updatedAt: this.now(),
      }
      await store.saveSteps(jobId, steps)
      await store.saveJob(record)
    }

    // 运行时参数：持久化 params（无凭据）+ 本次请求带来的凭据
    const runParams: SummaryJobParams = {
      ...record.params,
      apiKey: params.apiKey,
      userConfig: { ...record.params.userConfig, userKey: params.userConfig.userKey },
    }

    this.canceledJobs.delete(jobId)
    this.runningJobs.add(jobId)
    try {
      await this.executeJob(jobId, record, steps, runParams)
    } finally {
      this.runningJobs.delete(jobId)
      this.canceledJobs.delete(jobId)
      clearInterval(renewTimer)
      await store.releaseJobLock(jobId, holderId)
      await store.clearCancelFlag(jobId).catch(() => undefined)
    }

    const finalRecord = await store.loadJob(jobId)
    const finalSteps = (await store.loadSteps(jobId)) ?? []
    if (!finalRecord) {
      throw new Error(`[jobs] job record vanished during execution: ${jobId}`)
    }
    return { snapshot: { record: finalRecord, steps: finalSteps }, reused: false }
  }

  /** load-or-create：job 记录与 steps 不存在时落盘 queued 初始态（幂等） */
  async ensureJobRecord(
    jobId: string,
    digest: string,
    params: SummaryJobParams,
  ): Promise<{ record: JobRecord; steps: JobStepRecord[] }> {
    const store = this.options.store
    const existingRecord = await store.loadJob(jobId)
    if (existingRecord) {
      const existingSteps = await store.loadSteps(jobId)
      if (existingSteps) {
        return { record: existingRecord, steps: existingSteps }
      }
      // steps 缺失/损坏（部分写入或独立过期）：保留原记录（succeeded 结果、
      // attempt、checkpoint、error 都不能抹掉），仅按 params 重建 queued steps
      const rebuilt = buildSteps(existingRecord.params.chunks.length, this.stepMaxAttempts)
      await store.saveSteps(jobId, rebuilt)
      console.warn(`[jobs] rebuilt missing steps for ${jobId} (record preserved, status=${existingRecord.status})`)
      return { record: existingRecord, steps: rebuilt }
    }
    const record: JobRecord = {
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
      // apiKey/userKey 只随运行时参数传递，持久化记录一律剥离
      params: stripSecrets(params),
    }
    const steps = buildSteps(params.chunks.length, this.stepMaxAttempts)
    await store.saveJob(record)
    await store.saveSteps(jobId, steps)
    await store.addActiveIndex(jobId, record.createdAt)
    return { record, steps }
  }

  /**
   * 拿锁（带等待）：另一实例在跑同一 job 时先等它完成。
   * - acquired：获得执行权
   * - completed：等待期间 job 已被跑成 succeeded，调用方可直接复用
   * - busy：等到上限仍未获得（调用方抛 JOB_LOCK_BUSY）
   */
  private async acquireJobLockWithWait(
    jobId: string,
    holderId: string,
    forceNewResult: boolean,
  ): Promise<'acquired' | 'completed' | 'busy'> {
    const deadline = this.now() + this.lockWaitMs
    while (true) {
      if (await this.options.store.acquireJobLock(jobId, holderId, this.lockTtlMs)) {
        return 'acquired'
      }
      if (this.now() >= deadline) {
        return 'busy'
      }
      await this.sleep(this.lockRetryIntervalMs)
      if (!forceNewResult) {
        const record = await this.options.store.loadJob(jobId)
        if (record?.status === 'succeeded' && record.resultText) {
          return 'completed'
        }
      }
    }
  }

  private async executeJob(
    jobId: string,
    record: JobRecord,
    existingSteps: JobStepRecord[],
    runParams: SummaryJobParams,
  ) {
    const store = this.options.store

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

    // 持久化写串行化：多 worker 并发 commit 时，按发起顺序落盘，防止慢的
    // saveSteps 完成后覆盖快照回退（内存闭包 steps 始终单调前进）
    let persistChain: Promise<void> = Promise.resolve()
    const enqueuePersist = (write: () => Promise<void>): Promise<void> => {
      persistChain = persistChain.then(write, write)
      return persistChain
    }
    const persistStep = async (index: number, patch: Partial<JobStepRecord>) => {
      steps = steps.map((step) => (step.index === index ? { ...step, ...patch } : step))
      await enqueuePersist(() => store.saveSteps(jobId, steps))
    }
    const persistJob = async () => {
      const succeededChunks = steps
        .filter((step) => step.kind === 'chunk' && step.status === 'succeeded')
        .map((step) => step.chunkIndex!)
      working = { ...working, checkpoint: succeededChunks, updatedAt: this.now() }
      await enqueuePersist(() => store.saveJob(working))
    }

    // ---- map：worker pool 并行执行 chunk 摘要，并发不超上限 ----
    const pendingIndexes = steps.filter((step) => step.kind === 'chunk' && step.status === 'queued').map((s) => s.index)
    let cursor = 0
    // 持有对象避免 TS 控制流把闭包内赋值的 failure 收窄为 null
    const runState: { failure: JobError | null } = { failure: null }

    const worker = async () => {
      while (!(await this.checkCanceled(jobId)) && !runState.failure) {
        const claimed = cursor
        cursor += 1
        if (claimed >= pendingIndexes.length) {
          return
        }
        const stepIndex = pendingIndexes[claimed]
        const step = steps.find((candidate) => candidate.index === stepIndex)!
        try {
          await this.runStepWithRetries(jobId, step, runParams, async (patch) => {
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

    if (await this.checkCanceled(jobId)) {
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
          runParams,
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

    // reduce 完成/复用后、写入 succeeded 终态前，最后一次兑现取消请求
    if (await this.checkCanceled(jobId)) {
      const snapshot = await this.getJob(jobId)
      if (snapshot) {
        await this.finalizeCanceled(snapshot)
      }
      throw new JobFailureError('CANCELED', 'job canceled by user', 'canceled')
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
   * fetchOpenAIResult 不支持注入 abortSignal，无法真正中止超时的 provider
   * 调用；因此超时后有界等待该次 attempt settle（最多再等一个超时周期，
   * provider promise 永不 settle 时不会挂死 job），然后才进入重试判定，
   * 否则反复超时下实际在途请求数会突破并发上限（孤儿结果被忽略，缓存写入幂等无害）。
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
      const attemptPromise =
        step.kind === 'chunk'
          ? this.options.runner.runChunk(params, step.chunkIndex!)
          : this.options.runner.runReduce(params, chunkOutputs ?? [])
      try {
        const raw = await this.withTimeout(attemptPromise)
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
        // 超时只是放弃等待，provider 调用仍在途。fetchOpenAIResult 不支持
        // abortSignal，无法中止：有界等待它 settle（上界 = 一个超时周期）。
        // - settle：正常进入重试判定，保证重试与孤儿不同时在途（并发上限不被突破）
        // - 到界仍未 settle：按 TIMEOUT 判死本步骤（不重试），既不挂死 job，
        //   也不让重试与永挂请求叠加
        if (error instanceof StepTimeoutError) {
          const settled = await this.waitUntilSettled(attemptPromise, this.stepTimeoutMs)
          if (!settled) {
            const timeoutError = toJobError(error, step.index)
            await commit({ status: 'failed', error: timeoutError, finishedAt: this.now() })
            throw new JobFailureError(timeoutError.code, timeoutError.message, 'failed')
          }
        }
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

  /** 有界等待 promise settle：返回是否在上界内 settle（false = 到界仍在途） */
  private waitUntilSettled(promise: Promise<unknown>, boundMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const finish = (settled: boolean) => {
        clearTimeout(timer)
        resolve(settled)
      }
      const timer = setTimeout(() => finish(false), boundMs)
      void promise.then(
        () => finish(true),
        () => finish(true),
      )
    })
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
