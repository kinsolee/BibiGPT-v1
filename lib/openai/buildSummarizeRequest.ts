import { fetchSubtitle, SubtitleFetchResult } from '~/lib/fetchSubtitle'
import {
  chunkSubtitles,
  DEFAULT_CHUNK_BYTE_LIMIT,
  getUtf8ByteLength,
  TIMESTAMP_CHUNK_BYTE_LIMIT,
  TranscriptChunk,
} from '~/lib/openai/getSmallSizeTranscripts'
import { ChatGPTAgent, OpenAIStreamPayload } from '~/lib/openai/fetchOpenAIResult'
import { getUserSubtitlePrompt, getUserSubtitleWithTimestampPrompt } from '~/lib/openai/prompt'
import { sourceErrorCodeToHttpStatus, SourceError } from '~/lib/sources/types'
import {
  isLikelyThinkingModel,
  resolveCacheIdContext,
  resolveModelTarget,
  THINKING_MODEL_MIN_OUTPUT_TOKENS,
} from '~/lib/models/registry'
import { CacheIdContext } from '~/lib/models/types'
import { JobChunkSpec } from '~/lib/jobs/types'
import { CommonSubtitleItem, SummarizeParams } from '~/lib/types'
import { isDev } from '~/utils/env'

export class SummarizeRequestError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'SummarizeRequestError'
    this.statusCode = statusCode
  }
}

export type SummarizePlan = 'fast' | 'job'

export interface BuiltSummarizeRequest {
  openAiPayload: OpenAIStreamPayload
  userKey?: string
  baseUrl?: string
  cacheContext: CacheIdContext
  modelTarget: ReturnType<typeof resolveModelTarget>
  videoId: string
  title: string | null
  subtitlesArray: Array<CommonSubtitleItem> | null
  descriptionText: string | undefined
  /** fast = 单 chunk 同步流式（行为与旧链路一致）；job = 多 chunk 走 map-reduce 异步管线 */
  plan: SummarizePlan
  /** 确定性切分结果；fast path 恰好 0/1 个 chunk */
  chunks: TranscriptChunk[]
  detailTokens: number
}

/** 长文本兜底切分：按段落切块（无时间轴信息） */
function chunkPlainText(text: string): TranscriptChunk[] {
  const paragraphs = text
    .split(/\n+/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0)
  if (paragraphs.length <= 1) {
    return chunkSubtitles([{ text, index: 0 }])
  }
  return chunkSubtitles(paragraphs.map((piece, index) => ({ text: piece, index })))
}

export function toJobChunkSpecs(chunks: TranscriptChunk[]): JobChunkSpec[] {
  return chunks.map(({ index, hash, text, byteLength, startSeconds, endSeconds }) => ({
    index,
    hash,
    text,
    byteLength,
    startSeconds,
    endSeconds,
  }))
}

export async function buildSummarizeOpenAIPayload({
  videoConfig,
  userConfig,
}: SummarizeParams): Promise<BuiltSummarizeRequest> {
  const { userKey, baseUrl, shouldShowTimestamp } = userConfig || {}
  const { videoId } = videoConfig

  if (!videoId) {
    throw new SummarizeRequestError(500, 'No videoId in the request')
  }

  let subtitles: SubtitleFetchResult
  try {
    subtitles = await fetchSubtitle(videoConfig, shouldShowTimestamp)
  } catch (error) {
    if (error instanceof SourceError) {
      // 错误码进 message 前缀，UI/API 可区分 NO_TRANSCRIPT / AUTH_REQUIRED / SOURCE_UNAVAILABLE / RATE_LIMITED
      throw new SummarizeRequestError(sourceErrorCodeToHttpStatus(error.code), `${error.code}: ${error.message}`)
    }
    throw error
  }
  const { title, subtitlesArray, descriptionText } = subtitles
  if (!subtitlesArray && !descriptionText) {
    console.error('No subtitle in the video: ', videoId)
    throw new SummarizeRequestError(501, 'No subtitle in the video')
  }

  // 确定性切分：短输入恰好 1 个 chunk（文本与旧 join 行为一致），长输入多 chunk 走 job。
  // timestamp 模式收紧预算：prompt 侧会 JSON.stringify 膨胀，防止 6200 二次截断丢内容
  const byteLimit = shouldShowTimestamp ? TIMESTAMP_CHUNK_BYTE_LIMIT : DEFAULT_CHUNK_BYTE_LIMIT
  const chunks = subtitlesArray ? chunkSubtitles(subtitlesArray, byteLimit) : chunkPlainText(descriptionText ?? '')
  const plan: SummarizePlan = chunks.length > 1 ? 'job' : 'fast'
  const inputText = subtitlesArray ? chunks[0]?.text ?? '' : descriptionText ?? ''

  const userPrompt = shouldShowTimestamp
    ? getUserSubtitleWithTimestampPrompt(title, inputText, videoConfig)
    : getUserSubtitlePrompt(title, inputText, videoConfig)

  if (isDev) {
    console.log('final user prompt: ', userPrompt)
  }

  const modelTarget = resolveModelTarget({ model: videoConfig.model, baseUrl })
  const detailTokens = Number(videoConfig.detailLevel) || (userKey ? 800 : 600)
  const openAiPayload: OpenAIStreamPayload = {
    model: modelTarget.model,
    messages: [{ role: ChatGPTAgent.user, content: userPrompt }],
    max_tokens: isLikelyThinkingModel(modelTarget.model)
      ? Math.max(detailTokens, THINKING_MODEL_MIN_OUTPUT_TOKENS)
      : detailTokens,
    stream: Boolean(videoConfig.enableStream ?? true),
  }

  const cacheContext = resolveCacheIdContext({ baseUrl, model: videoConfig.model })

  if (plan === 'job') {
    console.info(
      `[summarize] job plan: video=${videoId} chunks=${chunks.length} totalBytes=${
        subtitlesArray
          ? getUtf8ByteLength(subtitlesArray.map((item) => item.text).join(' '))
          : getUtf8ByteLength(descriptionText ?? '')
      }`,
    )
  }

  return {
    openAiPayload,
    userKey,
    baseUrl: modelTarget.baseUrl,
    cacheContext,
    modelTarget,
    videoId,
    title: title ?? null,
    subtitlesArray: subtitlesArray ?? null,
    descriptionText,
    plan,
    chunks,
    detailTokens,
  }
}
