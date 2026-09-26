import { createHash } from 'crypto'

import { Redis } from '@upstash/redis'

import { isLikelyThinkingModel, resolveCacheIdContext, THINKING_MODEL_MIN_OUTPUT_TOKENS } from '~/lib/models/registry'
import { getCacheId } from '~/utils/getCacheId'
import { ChatGPTAgent, fetchOpenAIResult, OpenAIStreamPayload } from '~/lib/openai/fetchOpenAIResult'
import { buildChunkUserPrompt, buildReduceUserPrompt } from '~/lib/jobs/prompts'
import { JobEngine, JobFailureError, StepRunner } from '~/lib/jobs/engine'
import { JobChunkSpec, JobSnapshot, SummaryJobParams } from '~/lib/jobs/types'
import { getDefaultJobStore } from '~/lib/jobs/store'
import { UserConfig, VideoConfig } from '~/lib/types'

/** 参与 job 幂等摘要的配置键：与 getCacheId/toSummaryConfigSnapshot 的口径保持一致 */
const DIGEST_CONFIG_KEYS = [
  'model',
  'showTimestamp',
  'showEmoji',
  'outputLanguage',
  'detailLevel',
  'sentenceNumber',
  'outlineLevel',
] as const

export interface SummaryJobInput {
  videoConfig: VideoConfig
  userConfig: UserConfig
  title: string | null
  chunks: JobChunkSpec[]
  model: string
  provider: string
  baseUrl: string
  promptVersion: string
  detailTokens: number
  apiKey: string
}

export interface SummaryJobResult {
  jobId: string
  snapshot: JobSnapshot
  /** true = 直接复用了已完成 job 的结果，本轮没有调用 provider */
  reused: boolean
  summaryText: string
}

/** 稳定 JSON：对象键排序后序列化，保证 digest 跨进程一致 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/**
 * 同一输入（videoId+分P+配置快照+模型+provider+全部 chunk hash）得到同一 digest。
 * chunk hash 已覆盖 transcript 内容，字幕更新会自然产生新 job。
 */
export function buildSummaryJobDigest(input: SummaryJobInput) {
  const { videoConfig, userConfig } = input
  const configSnapshot: Record<string, unknown> = {}
  for (const key of DIGEST_CONFIG_KEYS) {
    if (videoConfig[key] !== undefined) {
      configSnapshot[key] = videoConfig[key]
    }
  }
  const material = {
    kind: 'summary',
    service: videoConfig.service ?? null,
    videoId: videoConfig.videoId,
    pageNumber: videoConfig.pageNumber ?? null,
    shouldShowTimestamp: userConfig.shouldShowTimestamp ?? Boolean(videoConfig.showTimestamp),
    // title 参与 chunk/reduce 提示词：标题变化必须产生新 job，否则沿用旧标题出摘要
    title: (input.title ?? '').trim(),
    model: input.model,
    provider: input.provider,
    baseUrl: input.baseUrl,
    promptVersion: input.promptVersion,
    config: configSnapshot,
    chunks: input.chunks.map((chunk) => chunk.hash),
  }
  return createHash('sha256').update(canonicalJson(material), 'utf8').digest('hex').slice(0, 32)
}

function outputTokensFor(model: string, detailTokens: number, isReduce: boolean) {
  const base = isReduce ? Math.max(detailTokens * 2, 1000) : detailTokens
  return isLikelyThinkingModel(model) ? Math.max(base, THINKING_MODEL_MIN_OUTPUT_TOKENS) : base
}

/** 生产 StepRunner：chunk/reduce 都走非流式 generateText，可整体落缓存与重试 */
export function createOpenAIStepRunner(): StepRunner {
  return {
    async runChunk(params: SummaryJobParams, chunkIndex: number): Promise<string> {
      const chunk = params.chunks[chunkIndex]
      if (!chunk) {
        throw new JobFailureError('CHUNK_NOT_FOUND', `chunk ${chunkIndex} missing in job params`, 'failed')
      }
      const prompt = buildChunkUserPrompt({
        title: params.title,
        chunk,
        totalChunks: params.chunks.length,
        videoConfig: params.videoConfig,
        shouldShowTimestamp: params.userConfig.shouldShowTimestamp,
      })
      // 合成 videoId 让每个 chunk 拿到独立 cacheId，避免互相覆盖主视频缓存
      const syntheticVideoConfig = {
        ...params.videoConfig,
        videoId: `${params.videoConfig.videoId}#chunk${chunkIndex}`,
      }
      const payload: OpenAIStreamPayload = {
        model: params.model,
        messages: [{ role: ChatGPTAgent.user, content: prompt }],
        max_tokens: outputTokensFor(params.model, params.detailTokens, false),
        stream: false,
      }
      const result = await fetchOpenAIResult(
        payload,
        params.apiKey,
        syntheticVideoConfig,
        params.baseUrl,
        resolveCacheIdContext({ baseUrl: params.baseUrl, model: params.model }),
      )
      return typeof result === 'string' ? result : String(result)
    },

    async runReduce(params: SummaryJobParams, chunkOutputs: string[]): Promise<string> {
      if (chunkOutputs.some((output) => !output.trim())) {
        throw new JobFailureError('REDUCE_INPUT_EMPTY', 'reduce received empty chunk output', 'failed')
      }
      const prompt = buildReduceUserPrompt({
        title: params.title,
        chunks: params.chunks,
        chunkOutputs,
        videoConfig: params.videoConfig,
        shouldShowTimestamp: params.userConfig.shouldShowTimestamp,
      })
      const syntheticVideoConfig = { ...params.videoConfig, videoId: `${params.videoConfig.videoId}#reduce` }
      const payload: OpenAIStreamPayload = {
        model: params.model,
        messages: [{ role: ChatGPTAgent.user, content: prompt }],
        max_tokens: outputTokensFor(params.model, params.detailTokens, true),
        stream: false,
      }
      const result = await fetchOpenAIResult(
        payload,
        params.apiKey,
        syntheticVideoConfig,
        params.baseUrl,
        resolveCacheIdContext({ baseUrl: params.baseUrl, model: params.model }),
      )
      return typeof result === 'string' ? result : String(result)
    },
  }
}

let sharedEngine: JobEngine | null = null

export function getSharedJobEngine(): JobEngine {
  if (!sharedEngine) {
    sharedEngine = new JobEngine({
      store: getDefaultJobStore(),
      runner: createOpenAIStepRunner(),
    })
  }
  return sharedEngine
}

/** 测试/工具用：重置共享 engine（不影响生产） */
export function resetSharedJobEngine() {
  sharedEngine = null
}

/**
 * job 最终结果回写 canonical 缓存 key（原始 videoConfig 口径，与
 * fetchOpenAIResult 的 cacheCompletedResult 一致：裸 string、fail-open）。
 * 否则 reduce 只写 `#reduce` 合成 key，middleware/proxy 查原始 key 命中旧摘要，
 * 会拦截后续请求到不了 digest-aware job。
 * 注意：KIN-40 合并后若缓存改为 envelope 格式，只需调整本函数（唯一接线点）。
 */
export async function writeJobResultToCanonicalCache(input: SummaryJobInput, summaryText: string): Promise<void> {
  if (!summaryText.trim()) {
    return
  }
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    return
  }
  try {
    const redis = Redis.fromEnv()
    const cacheId = getCacheId(input.videoConfig, resolveCacheIdContext({ baseUrl: input.baseUrl, model: input.model }))
    await redis.set(cacheId, summaryText)
    console.info(`[jobs] canonical cache updated: ${cacheId}`)
  } catch (error) {
    // 回写失败不影响 job 结果本身，与摘要主链路的缓存语义一致（fail-open）
    console.error('[jobs] canonical cache write failed:', error)
  }
}

/**
 * 入队即返回（opt-in 异步模式）：不等待执行，立即返回 jobId，
 * 调用方可轮询 GET /api/sumup?jobId=... 获取状态。
 * 仅适用于自托管长驻进程（Next 自定义 server/docker），API handler 返回后
 * 进程继续执行后台 promise。
 */
export function startSummaryJobInBackground(
  input: SummaryJobInput,
  options: { forceNewResult?: boolean; engine?: JobEngine } = {},
): { jobId: string } {
  const jobId = `job_${buildSummaryJobDigest(input)}`
  void runSummaryToCompletion(input, options).catch((error: unknown) => {
    console.error(`[jobs] background job ${jobId} failed:`, error instanceof Error ? error.message : error)
  })
  return { jobId }
}

/**
 * 摘要 job 入口：幂等创建或从 checkpoint 续传，驱动到终态后返回最终全文。
 * 失败抛 JobFailureError（code/status），由 API 层映射为 HTTP 响应。
 */
export async function runSummaryToCompletion(
  input: SummaryJobInput,
  options: { forceNewResult?: boolean; engine?: JobEngine } = {},
): Promise<SummaryJobResult> {
  const digest = buildSummaryJobDigest(input)
  const engine = options.engine ?? getSharedJobEngine()
  const params: SummaryJobParams = {
    videoConfig: input.videoConfig,
    userConfig: input.userConfig,
    title: input.title,
    chunks: input.chunks,
    model: input.model,
    provider: input.provider,
    baseUrl: input.baseUrl,
    promptVersion: input.promptVersion,
    detailTokens: input.detailTokens,
    apiKey: input.apiKey,
  }
  const { snapshot, reused } = await engine.runSummaryJob(params, digest, {
    forceNewResult: options.forceNewResult,
  })
  if (snapshot.record.status !== 'succeeded' || !snapshot.record.resultText) {
    const error = snapshot.record.error
    throw new JobFailureError(error?.code ?? 'JOB_NOT_SUCCEEDED', error?.message ?? 'job did not succeed', 'failed')
  }
  if (!reused) {
    await writeJobResultToCanonicalCache(input, snapshot.record.resultText)
  }
  return {
    jobId: snapshot.record.id,
    snapshot,
    reused,
    summaryText: snapshot.record.resultText,
  }
}
