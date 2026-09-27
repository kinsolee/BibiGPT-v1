import { getUserSubtitlePrompt, getUserSubtitleWithTimestampPrompt } from '~/lib/openai/prompt'
import { fetchOpenAIResult, ChatGPTAgent } from '~/lib/openai/fetchOpenAIResult'
import {
  chunkSubtitles,
  DEFAULT_CHUNK_BYTE_LIMIT,
  TIMESTAMP_CHUNK_BYTE_LIMIT,
} from '~/lib/openai/getSmallSizeTranscripts'
import { selectApiKeyAndActivatedLicenseKey } from '~/lib/openai/selectApiKeyAndActivatedLicenseKey'
import { resolveCacheIdContext, resolveModelTarget } from '~/lib/models/registry'
import { runSummaryToCompletion, startSummaryJobInBackground } from '~/lib/jobs/summaryJob'
import { transcriptToPlainTextItems, transcriptToSubtitleItems } from '../toSubtitleItems'
import { buildLocalFileUrl } from '~/lib/storage/localStore'
import { SourceError, sourceErrorCodeToHttpStatus } from '../types'
import type { MediaDocument, TranscriptSegment } from '../types'
import { findExtendedSourceAdapter } from './extendedRegistry'
import { CommonSubtitleItem, VideoService } from '~/lib/types'

export type IngestMode = 'transcript' | 'summary'

export interface IngestOptions {
  mode?: IngestMode
  userKey?: string
  baseUrl?: string
  model?: string
  shouldShowTimestamp?: boolean
  outputLanguage?: string
  sentenceNumber?: number
  showEmoji?: boolean
  detailLevel?: number
  outlineLevel?: number
}

export interface IngestResult {
  source: {
    sourceRef: string
    sourceUrl: string
    service: string
    title: string
    duration?: number
    language?: string
  }
  transcript: TranscriptSegment[]
  /** /api/sumup 摘要输入同款契约（CommonSubtitleItem[]） */
  subtitleItems: CommonSubtitleItem[]
  plainItems: Array<{ text: string; index: number }>
  summary?: {
    text: string
    plan: 'fast' | 'job'
    jobId?: string
  }
}

export class IngestHttpError extends Error {
  readonly statusCode: number
  readonly errorCode?: string

  constructor(statusCode: number, message: string, errorCode?: string) {
    super(message)
    this.name = 'IngestHttpError'
    this.statusCode = statusCode
    this.errorCode = errorCode
  }
}

function mapSourceError(error: SourceError): IngestHttpError {
  return new IngestHttpError(sourceErrorCodeToHttpStatus(error.code), `${error.code}: ${error.message}`, error.code)
}

function resolveIngestUrl(input: { fileId?: string; sourceUrl?: string }): string {
  if (input.fileId) {
    return buildLocalFileUrl(input.fileId)
  }
  if (input.sourceUrl) {
    return input.sourceUrl
  }
  throw new IngestHttpError(400, 'Missing fileId or sourceUrl')
}

function mapServiceEnum(document: MediaDocument): VideoService | undefined {
  if (document.service === 'podcast') {
    return VideoService.Podcast
  }
  if (document.service === 'youtube') {
    return VideoService.Youtube
  }
  return undefined
}

/** ingest 核心：URL/fileId → MediaDocument → transcript 或完整摘要（复用 KIN-39 job 管线） */
export async function runIngest(
  input: { fileId?: string; sourceUrl?: string },
  options: IngestOptions = {},
): Promise<IngestResult> {
  const url = resolveIngestUrl(input)
  const adapter = findExtendedSourceAdapter(url)
  if (!adapter) {
    throw new IngestHttpError(400, `URL 不在新来源白名单内: ${url}`)
  }

  let document: MediaDocument
  try {
    document = await adapter.fetch(url)
  } catch (error) {
    if (error instanceof SourceError) {
      throw mapSourceError(error)
    }
    throw error
  }

  if (!document.transcript.length) {
    throw mapSourceError(new SourceError('NO_TRANSCRIPT', `来源没有可用的 transcript: ${url}`))
  }

  const shouldShowTimestamp = Boolean(options.shouldShowTimestamp)
  const subtitleItems = transcriptToSubtitleItems(document.transcript, shouldShowTimestamp)
  const plainItems = transcriptToPlainTextItems(document.transcript)

  const result: IngestResult = {
    source: {
      sourceRef: document.sourceRef,
      sourceUrl: document.sourceUrl,
      service: document.service,
      title: document.title,
      duration: document.duration,
      language: document.language,
    },
    transcript: document.transcript,
    subtitleItems,
    plainItems,
  }

  if (options.mode !== 'summary') {
    return result
  }

  result.summary = await summarizeTranscript(document, subtitleItems, options)
  return result
}

async function summarizeTranscript(
  document: MediaDocument,
  subtitleItems: CommonSubtitleItem[],
  options: IngestOptions,
): Promise<{ text: string; plan: 'fast' | 'job'; jobId?: string }> {
  const shouldShowTimestamp = Boolean(options.shouldShowTimestamp)
  const byteLimit = shouldShowTimestamp ? TIMESTAMP_CHUNK_BYTE_LIMIT : DEFAULT_CHUNK_BYTE_LIMIT
  const chunks = chunkSubtitles(subtitleItems, byteLimit, { encodedWeight: Boolean(options.shouldShowTimestamp) })
  if (!chunks.length) {
    throw new IngestHttpError(501, 'NO_TRANSCRIPT: transcript 切分后为空', 'NO_TRANSCRIPT')
  }

  const videoConfig = {
    videoId: document.sourceRef,
    ...(mapServiceEnum(document) ? { service: mapServiceEnum(document) } : {}),
    model: options.model,
    outputLanguage: options.outputLanguage,
    sentenceNumber: options.sentenceNumber,
    showEmoji: options.showEmoji,
    detailLevel: options.detailLevel,
    outlineLevel: options.outlineLevel,
    showTimestamp: options.shouldShowTimestamp,
  }
  const userConfig = {
    userKey: options.userKey,
    baseUrl: options.baseUrl,
    shouldShowTimestamp: Boolean(options.shouldShowTimestamp),
  }

  const modelTarget = resolveModelTarget({ model: options.model, baseUrl: options.baseUrl })
  const cacheContext = resolveCacheIdContext({
    baseUrl: modelTarget.baseUrl,
    model: options.model,
    transcriptText: chunks.map((chunk) => chunk.text).join(' '),
  })
  const detailTokens = Number(options.detailLevel) || 600
  const plan = chunks.length > 1 ? 'job' : 'fast'
  const inputText = shouldShowTimestamp ? chunks[0]?.text ?? '' : document.transcript.map((s) => s.text).join(' ')
  const userPrompt = shouldShowTimestamp
    ? getUserSubtitleWithTimestampPrompt(document.title, inputText, videoConfig as any)
    : getUserSubtitlePrompt(document.title, inputText, videoConfig as any)

  const apiKey = await selectApiKeyAndActivatedLicenseKey(options.userKey, videoConfig.videoId)

  if (plan === 'fast') {
    const summaryText = await fetchOpenAIResult(
      {
        model: modelTarget.model,
        messages: [{ role: ChatGPTAgent.user, content: userPrompt }],
        max_tokens: detailTokens,
        stream: false,
      },
      apiKey,
      videoConfig as any,
      modelTarget.baseUrl,
      cacheContext,
    )
    return { text: typeof summaryText === 'string' ? summaryText : String(summaryText), plan }
  }

  const jobInput = {
    videoConfig: videoConfig as any,
    userConfig,
    title: document.title,
    chunks: chunks.map(({ index, hash, text, byteLength, startSeconds, endSeconds }) => ({
      index,
      hash,
      text,
      byteLength,
      startSeconds,
      endSeconds,
    })),
    model: modelTarget.model,
    provider: modelTarget.provider,
    baseUrl: modelTarget.baseUrl,
    promptVersion: cacheContext.promptVersion,
    detailTokens,
    apiKey,
  }

  if (process.env.BIBI_JOB_ASYNC_RETURN === '1') {
    const { jobId } = await startSummaryJobInBackground(jobInput as any)
    return { text: '', plan: 'job', jobId }
  }
  const jobResult = await runSummaryToCompletion(jobInput as any)
  return { text: jobResult.summaryText, plan: 'job', jobId: jobResult.jobId }
}
