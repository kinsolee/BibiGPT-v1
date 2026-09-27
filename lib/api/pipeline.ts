import {
  commonSubtitlesToSegments,
  buildSourceUrl as buildCanonicalSourceUrl,
  toSummaryConfigSnapshot,
} from '~/lib/history/adapters'
import { persistSummarizedContent } from '~/lib/history/persist'
import { buildSummaryJobDigest, getSharedJobEngine, startSummaryJobInBackground } from '~/lib/jobs/summaryJob'
import { classifyUpstreamError, redactSecrets } from '~/lib/models/errors'
import { buildSummarizeOpenAIPayload, SummarizeRequestError, toJobChunkSpecs } from '~/lib/openai/buildSummarizeRequest'
import { selectApiKeyAndActivatedLicenseKey } from '~/lib/openai/selectApiKeyAndActivatedLicenseKey'
import { parseVideoSourceUrl } from '~/lib/sources/registry'
import { buildBilibiliSourceRef, buildYoutubeSourceRef } from '~/lib/sources/sourceRef'
import { SourceError } from '~/lib/sources/types'
import type { MediaDocumentMetadata } from '~/lib/history/types'
import { VideoService } from '~/lib/types'
import type { VideoConfig } from '~/lib/types'
import { getServiceSupabase } from './supabaseService'
import { v1ErrorFromSourceCode } from './errors'
import { V1Error } from './errors'
import type { V1SubmitInput, V1SubmitOutcome, V1SubmitPipeline } from './handlers/submit'

/**
 * 任意未知错误 → V1Error 的统一映射：
 * SummarizeRequestError（message 前缀带 SourceErrorCode，与 lib/batch worker 同口径）、
 * SourceError、classifyUpstreamError 的 provider 错误分类。
 */
export function v1ErrorFromUnknown(error: unknown): V1Error {
  if (error instanceof V1Error) {
    return error
  }
  if (error instanceof SummarizeRequestError) {
    const prefixed = /^([A-Z_]+):\s*([\s\S]+)$/.exec(error.message)
    if (prefixed) {
      const sourceCodes: Record<string, string> = {
        NO_TRANSCRIPT: 'NO_TRANSCRIPT',
        AUTH_REQUIRED: 'FORBIDDEN',
        SOURCE_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
        RATE_LIMITED: 'RATE_LIMITED',
      }
      const mapped = sourceCodes[prefixed[1]]
      if (mapped) {
        return new V1Error(mapped as V1Error['code'], prefixed[2])
      }
    }
    if (error.statusCode === 501) {
      return new V1Error('NO_TRANSCRIPT', error.message)
    }
    if (error.statusCode === 400) {
      return new V1Error('INVALID_REQUEST', error.message)
    }
    return new V1Error('INTERNAL', redactSecrets(error.message))
  }
  if (error instanceof SourceError) {
    return v1ErrorFromSourceCode(error.code, error.message)
  }
  const classified = classifyUpstreamError(error)
  if (classified?.kind) {
    const message = redactSecrets(classified.message)
    switch (classified.kind) {
      case 'MODEL_NOT_FOUND':
      case 'CAPABILITY_UNSUPPORTED':
        return new V1Error('INVALID_REQUEST', message)
      case 'TIMEOUT':
        return new V1Error('UPSTREAM_TIMEOUT', message)
      case 'RATE_LIMITED':
        return new V1Error('RATE_LIMITED', message)
      case 'UPSTREAM_AUTH':
      case 'UPSTREAM_5XX':
        return new V1Error('SOURCE_UNAVAILABLE', message)
      default:
        return new V1Error('INTERNAL', message)
    }
  }
  return new V1Error('INTERNAL', redactSecrets(error instanceof Error ? error.message : String(error)))
}

interface V1SubmitPipelineContext {
  videoConfig: VideoConfig
  service: 'youtube' | 'bilibili'
  sourceRef: string
  sourcePage: string | null
  media: MediaDocumentMetadata
  built: Awaited<ReturnType<typeof buildSummarizeOpenAIPayload>>
}

/**
 * 默认 submit 管线（仅路由层加载；fixture 注入 fake 管线不经过本模块）：
 * 1. parseVideoSourceUrl 白名单解析（不支持域名 → 422 UNSUPPORTED_SOURCE）
 * 2. buildSummarizeOpenAIPayload 抓字幕并确定性切分（NO_TRANSCRIPT → 501 等）
 * 3. 计算 job digest → 已有 queued/running/succeeded 记复用，failed/canceled 重新驱动
 * 4. 后台 job 成功后把 summary/transcript 落库（persistSummarizedContent）
 * 5. 返回 202 { jobId, contentId(已有内容时), reused }
 */
export const v1SubmitPipeline: V1SubmitPipeline = async ({
  userId,
  sourceUrl,
  options,
}: V1SubmitInput): Promise<V1SubmitOutcome> => {
  const parsed = parseVideoSourceUrl(sourceUrl)
  if (!parsed) {
    throw new V1Error('UNSUPPORTED_SOURCE', `unsupported source url: ${sourceUrl}`, { sourceUrl })
  }
  const service: 'youtube' | 'bilibili' = parsed.adapter.id === 'youtube' ? 'youtube' : 'bilibili'
  const videoConfig: VideoConfig = {
    videoId: parsed.videoId,
    service: parsed.adapter.id === 'youtube' ? VideoService.Youtube : VideoService.Bilibili,
    pageNumber: parsed.pageNumber ?? null,
    enableStream: false,
    ...(options?.model ? { model: options.model } : {}),
    ...(options?.language ? { outputLanguage: options.language } : {}),
  }

  let built
  try {
    built = await buildSummarizeOpenAIPayload({ videoConfig, userConfig: {} })
  } catch (error) {
    throw v1ErrorFromUnknown(error)
  }

  const sourceRef =
    service === 'youtube'
      ? buildYoutubeSourceRef(parsed.videoId)
      : buildBilibiliSourceRef(parsed.videoId, parsed.pageNumber ?? null)
  const media: MediaDocumentMetadata = {
    sourceUrl: buildCanonicalSourceUrl(parsed.videoId, service, parsed.pageNumber ?? null),
    service,
    sourceRef,
    sourcePage: parsed.pageNumber ?? null,
    title: built.title,
    duration: null,
    language: null,
  }
  const context: V1SubmitPipelineContext = {
    videoConfig,
    service,
    sourceRef,
    sourcePage: parsed.pageNumber ?? null,
    media,
    built,
  }

  const apiKey = await selectApiKeyAndActivatedLicenseKey(built.userKey, built.videoId)
  const jobInput = {
    videoConfig,
    userConfig: {},
    title: built.title,
    chunks: toJobChunkSpecs(built.chunks),
    model: built.modelTarget.model,
    provider: built.modelTarget.provider,
    baseUrl: built.modelTarget.baseUrl,
    promptVersion: built.cacheContext.promptVersion,
    detailTokens: built.detailTokens,
    apiKey,
  }
  const digest = buildSummaryJobDigest(jobInput)
  const jobId = `job_${digest}`
  const engine = getSharedJobEngine()
  const supabase = getServiceSupabase()

  let reused = false
  const existing = await engine.getJob(jobId).catch(() => null)
  if (existing && (existing.record.status === 'queued' || existing.record.status === 'running')) {
    reused = true
  } else if (existing && existing.record.status === 'succeeded') {
    reused = true
    if (supabase && existing.record.resultText) {
      // 旧链路（/api/sumup 异步）完成不落库：复用成功结果时后台补持久化
      void persistOutcome(supabase, userId, context, existing.record.resultText)
    }
  } else {
    // 不存在或 failed/canceled：入队（engine 对 failed/canceled 从 checkpoint 续传重跑）
    try {
      await startSummaryJobInBackground(jobInput, {
        onCompleted: async (result) => {
          if (!supabase) {
            return
          }
          await persistOutcome(supabase, userId, context, result.summaryText)
        },
      })
    } catch (error) {
      throw v1ErrorFromUnknown(error)
    }
  }

  let contentId: string | null = null
  if (supabase) {
    contentId = await resolveContentId(supabase, userId, service, sourceRef, context.sourcePage).catch(() => null)
  }
  return { jobId, contentId, reused }
}

async function resolveContentId(
  supabase: NonNullable<ReturnType<typeof getServiceSupabase>>,
  userId: string,
  service: string,
  sourceRef: string,
  sourcePage: string | null,
): Promise<string | null> {
  let query = supabase
    .from('contents')
    .select('id')
    .eq('user_id', userId)
    .eq('service', service)
    .eq('source_ref', sourceRef)
  query = sourcePage === null ? query.is('source_page', null) : query.eq('source_page', sourcePage)
  const { data, error } = await query.maybeSingle()
  if (error) {
    throw error
  }
  return (data as { id: string } | null)?.id ?? null
}

async function persistOutcome(
  supabase: NonNullable<ReturnType<typeof getServiceSupabase>>,
  userId: string,
  context: V1SubmitPipelineContext,
  summaryText: string,
): Promise<void> {
  try {
    const segments = context.built.subtitlesArray ? commonSubtitlesToSegments(context.built.subtitlesArray) : []
    await persistSummarizedContent({
      supabase,
      userId,
      media: context.media,
      segments,
      config: toSummaryConfigSnapshot(context.videoConfig as unknown as Record<string, unknown>),
      model: context.built.modelTarget.model,
      summaryText,
    })
  } catch (error) {
    console.error(
      `[v1] persist content after summary failed: ${redactSecrets(
        error instanceof Error ? error.message : String(error),
      )}`,
    )
  }
}
