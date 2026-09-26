import { createHash } from 'crypto'

import { Redis } from '@upstash/redis'

import { isLikelyThinkingModel, resolveCacheIdContext, THINKING_MODEL_MIN_OUTPUT_TOKENS } from '~/lib/models/registry'
import { getCacheId } from '~/utils/getCacheId'
import { getUtf8ByteLength } from '~/lib/openai/getSmallSizeTranscripts'
import { selectApiKeyAndActivatedLicenseKey } from '~/lib/openai/selectApiKeyAndActivatedLicenseKey'
import type { BuiltSummarizeRequest } from '~/lib/openai/buildSummarizeRequest'
import { ChatGPTAgent, fetchOpenAIResult, OpenAIStreamPayload } from '~/lib/openai/fetchOpenAIResult'
import { buildChunkUserPrompt, buildReduceUserPrompt, SectionRange } from '~/lib/jobs/prompts'
import { JobEngine, JobFailureError, StepRunner } from '~/lib/jobs/engine'
import { JobChunkSpec, JobSnapshot, SummaryJobParams } from '~/lib/jobs/types'
import { getDefaultJobStore } from '~/lib/jobs/store'
import { isValidSummaryText } from '~/lib/jobs/validation'
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
    // 有效输出预算影响生成结果（detailLevel 缺省时由 userKey 推导 800/600），
    // 不同预算不得复用彼此的 job
    detailTokens: input.detailTokens,
    config: configSnapshot,
    chunks: input.chunks.map((chunk) => chunk.hash),
  }
  return createHash('sha256').update(canonicalJson(material), 'utf8').digest('hex').slice(0, 32)
}

function toSummaryJobParams(input: SummaryJobInput): SummaryJobParams {
  return {
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
}

function outputTokensFor(model: string, detailTokens: number, isReduce: boolean) {
  const base = isReduce ? Math.max(detailTokens * 2, 1000) : detailTokens
  return isLikelyThinkingModel(model) ? Math.max(base, THINKING_MODEL_MIN_OUTPUT_TOKENS) : base
}

/** 单次 reduce 请求的输入字节上界；超出则分层（hierarchical）归并后再发最终请求 */
export const DEFAULT_REDUCE_INPUT_BYTE_LIMIT = Number(process.env.BIBI_JOB_REDUCE_INPUT_BYTES) || 20_000

/**
 * 分层 reduce 分组：保序贪心装箱，每组（含 \n\n 分隔）≤ maxBytes；
 * 单条 section 超限则自成一组（由上层中间层压缩后自然收敛）。
 */
export function groupSectionsForReduce(sections: string[], maxBytes: number): string[][] {
  const groups: string[][] = []
  let current: string[] = []
  let currentBytes = 0
  for (const section of sections) {
    const bytes = getUtf8ByteLength(section)
    const separatorBytes = current.length > 0 ? 2 : 0
    if (current.length > 0 && currentBytes + separatorBytes + bytes > maxBytes) {
      groups.push(current)
      current = [section]
      currentBytes = bytes
    } else {
      current.push(section)
      currentBytes += separatorBytes + bytes
    }
  }
  if (current.length > 0) {
    groups.push(current)
  }
  return groups
}

/** 生产 StepRunner：chunk/reduce 都走非流式 generateText，可整体落缓存与重试 */
export function createOpenAIStepRunner(): StepRunner {
  const callReduceModel = async (
    params: SummaryJobParams,
    sections: string[],
    sectionRanges: SectionRange[],
    intermediate: boolean,
  ) => {
    if (sections.some((output) => !output.trim())) {
      throw new JobFailureError('REDUCE_INPUT_EMPTY', 'reduce received empty chunk output', 'failed')
    }
    const prompt = buildReduceUserPrompt({
      title: params.title,
      chunks: params.chunks,
      chunkOutputs: sections,
      videoConfig: params.videoConfig,
      shouldShowTimestamp: params.userConfig.shouldShowTimestamp,
      intermediate,
      sectionRanges,
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
    const text = typeof result === 'string' ? result : String(result)
    // 每一层（含中间层）都校验：2xx 错误页/裸 JSON 错误体混进任何一层都会污染最终摘要
    if (!isValidSummaryText(text)) {
      throw new JobFailureError(
        'PROVIDER_ERROR_PAGE',
        `provider returned empty or non-summary content at a reduce level (intermediate=${intermediate})`,
        'failed',
      )
    }
    return text
  }

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

    /**
     * 分层 reduce：拼接后的 section 摘要超过单请求输入上界
     * （DEFAULT_REDUCE_INPUT_BYTE_LIMIT）时，先按组做中间层归并
     * （consolidated notes），逐层收敛后再发最终 reduce。
     * sectionRanges 随层维护——归并组的区间为其覆盖的原始 chunk 区间的并集，
     * 中间层标注的是真实覆盖范围而非按位置的错位区间。
     * 中间层串行执行，共享本步骤的 step 超时/重试预算（层数≤8；极端
     * 不收敛时以最终 reduce 的截断语义兜底）。
     */
    async runReduce(params: SummaryJobParams, chunkOutputs: string[]): Promise<string> {
      let sections = chunkOutputs.map((output) => output.trim())
      let ranges: SectionRange[] = params.chunks.map((chunk) => ({
        startSeconds: chunk.startSeconds,
        endSeconds: chunk.endSeconds,
      }))
      let levels = 0
      while (
        sections.length > 1 &&
        getUtf8ByteLength(sections.join('\n\n')) > DEFAULT_REDUCE_INPUT_BYTE_LIMIT &&
        levels < 8
      ) {
        levels += 1
        const groups = groupSectionsForReduce(sections, DEFAULT_REDUCE_INPUT_BYTE_LIMIT)
        const merged: string[] = []
        const mergedRanges: SectionRange[] = []
        let offset = 0
        for (const group of groups) {
          // 组内各 section 沿用各自原始区间（中间层 header 标注准确）
          const groupRanges = ranges.slice(offset, offset + group.length)
          merged.push(await callReduceModel(params, group, groupRanges, true))
          // 归并后的新 section 区间 = 该组覆盖区间的并集（供下一层/最终层标注）
          mergedRanges.push({
            startSeconds: groupRanges[0]?.startSeconds ?? null,
            endSeconds: groupRanges[groupRanges.length - 1]?.endSeconds ?? null,
          })
          offset += group.length
        }
        sections = merged
        ranges = mergedRanges
      }
      return callReduceModel(params, sections, ranges, false)
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
 * 历史重生成等既有调用方的统一入口：按 plan 自动分流——
 * fast 走单次 fetchOpenAIResult（与旧链路一致），job 走 map-reduce 管线。
 * 供 pages/api/history/[id]/regenerate 接线替换「直接用 openAiPayload 调
 * fetchOpenAIResult」的旧写法（该文件属 KIN-41 文件域，由主会话接线）：
 * job plan 下 openAiPayload 只含首 chunk，直接调用会静默丢掉其余内容。
 */
export async function summarizeFromBuiltRequest(
  built: BuiltSummarizeRequest,
  options: { forceNewResult?: boolean; engine?: JobEngine } = {},
): Promise<{ text: string; jobId: string | null; plan: 'fast' | 'job' }> {
  const apiKey = await selectApiKeyAndActivatedLicenseKey(built.userKey, built.videoId)
  if (built.plan === 'fast') {
    const result = await fetchOpenAIResult(
      { ...built.openAiPayload, stream: false },
      apiKey,
      built.videoConfig,
      built.baseUrl,
      built.cacheContext,
    )
    return { text: typeof result === 'string' ? result : String(result), jobId: null, plan: 'fast' }
  }
  const result = await runSummaryToCompletion(
    {
      videoConfig: built.videoConfig,
      userConfig: { baseUrl: built.baseUrl, userKey: built.userKey, shouldShowTimestamp: built.shouldShowTimestamp },
      title: built.title,
      chunks: built.chunks.map(({ index, hash, text, byteLength, startSeconds, endSeconds }) => ({
        index,
        hash,
        text,
        byteLength,
        startSeconds,
        endSeconds,
      })),
      model: built.modelTarget.model,
      provider: built.modelTarget.provider,
      baseUrl: built.modelTarget.baseUrl,
      promptVersion: built.cacheContext.promptVersion,
      detailTokens: built.detailTokens,
      apiKey,
    },
    options,
  )
  return { text: result.summaryText, jobId: result.jobId, plan: 'job' }
}

/**
 * 入队即返回（opt-in 异步模式）：先把 queued 记录同步落盘（客户端拿到 202
 * 立即轮询不会 404），再后台驱动执行，立即返回 jobId。
 * 仅适用于自托管长驻进程（Next 自定义 server/docker），API handler 返回后
 * 进程继续执行后台 promise。
 */
export async function startSummaryJobInBackground(
  input: SummaryJobInput,
  options: { forceNewResult?: boolean; engine?: JobEngine } = {},
): Promise<{ jobId: string }> {
  const digest = buildSummaryJobDigest(input)
  const jobId = `job_${digest}`
  const engine = options.engine ?? getSharedJobEngine()
  await engine.ensureJobRecord(jobId, digest, toSummaryJobParams(input))
  void runSummaryToCompletion(input, options).catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[jobs] background job ${jobId} failed:`, message)
    // 启动阶段异常（store 错误/锁超时等）时 engine 可能没走到 finalize：
    // 把未终态记录迁移为 failed，轮询才能看到可重试的终态而不是永远 queued
    try {
      await engine.failJobIfNotTerminal(jobId, 'BACKGROUND_START_FAILED', message)
    } catch (failoverError) {
      console.error(`[jobs] background job ${jobId} failover failed:`, failoverError)
    }
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
  const params = toSummaryJobParams(input)
  const { snapshot, reused } = await engine.runSummaryJob(params, digest, {
    forceNewResult: options.forceNewResult,
  })
  if (snapshot.record.status !== 'succeeded' || !snapshot.record.resultText) {
    const error = snapshot.record.error
    throw new JobFailureError(error?.code ?? 'JOB_NOT_SUCCEEDED', error?.message ?? 'job did not succeed', 'failed')
  }
  // 复用路径也回写：首写失败或缓存被清后，后续复用请求会修复 canonical key，
  // 避免 proxy 永远 miss（幂等 SET，fail-open）
  await writeJobResultToCanonicalCache(input, snapshot.record.resultText)
  return {
    jobId: snapshot.record.id,
    snapshot,
    reused,
    summaryText: snapshot.record.resultText,
  }
}
