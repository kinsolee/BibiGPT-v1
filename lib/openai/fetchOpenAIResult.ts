import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { ModelMessage, generateText, streamText } from 'ai'
import { Redis } from '@upstash/redis'
import { classifyUpstreamError } from '~/lib/models/errors'
import { CacheIdContext } from '~/lib/models/types'
import { normalizeBaseUrl } from '~/lib/models/registry'
import {
  buildSummaryCacheEnvelope,
  hashTranscriptInput,
  readValidatedSummary,
  writeSummaryCacheEntry,
} from '~/lib/observability/summaryCache'
import { recordSummaryEvent } from '~/lib/observability/metrics'
import { trimOpenAiResult } from '~/lib/openai/trimOpenAiResult'
import { VideoConfig } from '~/lib/types'
import { getCacheId, getCacheReadIdCandidates } from '~/utils/getCacheId'

export enum ChatGPTAgent {
  user = 'user',
  system = 'system',
  assistant = 'assistant',
}

export interface ChatGPTMessage {
  role: ChatGPTAgent
  content: string
}
export interface OpenAIStreamPayload {
  api_key?: string
  model: string
  messages: ChatGPTMessage[]
  temperature?: number
  top_p?: number
  frequency_penalty?: number
  presence_penalty?: number
  max_tokens: number
  stream: boolean
  n?: number
}

// When a provider stream fails or emits nothing, retry at most once via
// non-stream generateText; never loop or chain fallbacks further.
const MAX_FALLBACK_ATTEMPTS = 1

function resolveProviderApiKey(apiKey?: string) {
  return apiKey || process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY || ''
}

function createProvider(apiKey: string, baseUrl?: string) {
  return createOpenAICompatible({
    baseURL: normalizeBaseUrl(baseUrl) || process.env.OPENAI_COMPATIBLE_BASE_URL || 'https://api.openai.com/v1',
    name: process.env.OPENAI_COMPATIBLE_PROVIDER_NAME || 'openai-compatible',
    apiKey,
  })
}

function toModelMessages(messages: ChatGPTMessage[]): ModelMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  })) as ModelMessage[]
}

interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

function toTokenUsage(usage: unknown): TokenUsage {
  const parsed = usage as { inputTokens?: unknown; outputTokens?: unknown } | null | undefined
  const toNumber = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return { inputTokens: toNumber(parsed?.inputTokens), outputTokens: toNumber(parsed?.outputTokens) }
}

async function readStreamUsage(usage: PromiseLike<unknown>): Promise<TokenUsage> {
  try {
    return toTokenUsage(await usage)
  } catch {
    return { inputTokens: 0, outputTokens: 0 }
  }
}

async function generateTextFallback(params: {
  model: ReturnType<ReturnType<typeof createProvider>['chatModel']>
  messages: ModelMessage[]
  payload: OpenAIStreamPayload
}): Promise<{ text: string; usage: TokenUsage }> {
  const result = await generateText({
    model: params.model,
    messages: params.messages,
    maxOutputTokens: params.payload.max_tokens,
    temperature: params.payload.temperature,
    topP: params.payload.top_p,
    frequencyPenalty: params.payload.frequency_penalty,
    presencePenalty: params.payload.presence_penalty,
  })

  return { text: trimOpenAiResult(result.text), usage: toTokenUsage(result.usage) }
}

export async function fetchOpenAIResult(
  payload: OpenAIStreamPayload,
  apiKey: string,
  videoConfig: VideoConfig,
  baseUrl?: string,
  cacheContext?: CacheIdContext,
) {
  const resolvedApiKey = resolveProviderApiKey(apiKey)
  if (!resolvedApiKey) {
    throw new Error('Missing API key for OpenAI-compatible provider')
  }

  const redis = Redis.fromEnv()
  const cacheId = getCacheId(videoConfig, cacheContext)
  const readCandidates = getCacheReadIdCandidates(videoConfig, cacheContext)
  const eventBase = {
    cacheId,
    // Hashed registry token only; raw base URLs and keys never enter metrics.
    provider: cacheContext?.provider,
    model: payload.model,
    origin: 'handler' as const,
  }

  const lookup = await readValidatedSummary(redis, {
    cacheId,
    fallbackIds: readCandidates.slice(1),
    origin: 'handler',
  })
  if (lookup.kind === 'hit' || lookup.kind === 'legacy-hit') {
    if (lookup.kind === 'legacy-hit') {
      // Migrate the still-valid legacy entry to the envelope format under the
      // new key so the migration window converges on its own.
      const transcriptHash = await hashTranscriptInput(JSON.stringify(payload.messages))
      const migrated = await writeSummaryCacheEntry(
        redis,
        cacheId,
        buildSummaryCacheEnvelope({ text: lookup.text, context: cacheContext, model: payload.model, transcriptHash }),
      )
      if (migrated) {
        recordSummaryEvent({ ...eventBase, event: 'cache-migration-write' })
      }
    }
    return lookup.text
  }

  const provider = createProvider(resolvedApiKey, baseUrl)
  const model = provider.chatModel(payload.model)
  const messages = toModelMessages(payload.messages)
  const transcriptHash = await hashTranscriptInput(JSON.stringify(messages))
  const startedAt = Date.now()

  if (!payload.stream) {
    const { text, usage } = await generateTextFallback({ model, messages, payload })
    await writeSummaryCacheEntry(
      redis,
      cacheId,
      buildSummaryCacheEnvelope({ text, context: cacheContext, model: payload.model, transcriptHash }),
    )
    recordSummaryEvent({ ...eventBase, event: 'summarize-success', latencyMs: Date.now() - startedAt, ...usage })
    return text
  }

  const result = streamText({
    model,
    messages,
    maxOutputTokens: payload.max_tokens,
    temperature: payload.temperature,
    topP: payload.top_p,
    frequencyPenalty: payload.frequency_penalty,
    presencePenalty: payload.presence_penalty,
  })

  const encoder = new TextEncoder()
  let tempData = ''
  let fallbackAttempts = 0
  let fallbackFrom: string | undefined
  const stream = new ReadableStream({
    async start(controller) {
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
      try {
        for await (const textPart of result.textStream) {
          tempData += textPart
          controller.enqueue(encoder.encode(textPart))
        }
        usage = await readStreamUsage(result.usage)

        // Edge runtime can fail to decode provider stream in some environments.
        // If stream finished but emitted no usable content, fallback to non-stream.
        if (!tempData.trim() && fallbackAttempts < MAX_FALLBACK_ATTEMPTS) {
          fallbackAttempts += 1
          fallbackFrom = 'empty-stream'
          recordSummaryEvent({ ...eventBase, event: 'summarize-fallback', fallbackFrom })
          const fallback = await generateTextFallback({ model, messages, payload })
          usage = fallback.usage
          if (fallback.text) {
            tempData = fallback.text
            controller.enqueue(encoder.encode(fallback.text))
          }
        }

        controller.close()
        await writeSummaryCacheEntry(
          redis,
          cacheId,
          buildSummaryCacheEnvelope({ text: tempData, context: cacheContext, model: payload.model, transcriptHash }),
        )
        recordSummaryEvent({
          ...eventBase,
          event: 'summarize-success',
          latencyMs: Date.now() - startedAt,
          fallbackFrom,
          ...usage,
        })
      } catch (streamError) {
        const classified = classifyUpstreamError(streamError)

        // Only degrade to non-stream when nothing was emitted yet; appending a
        // full retry after partial content would duplicate output.
        if (!tempData.trim() && fallbackAttempts < MAX_FALLBACK_ATTEMPTS) {
          fallbackAttempts += 1
          recordSummaryEvent({ ...eventBase, event: 'summarize-fallback', fallbackFrom: classified.kind })
          try {
            const fallback = await generateTextFallback({ model, messages, payload })
            tempData = fallback.text
            controller.enqueue(encoder.encode(fallback.text))
            controller.close()
            await writeSummaryCacheEntry(
              redis,
              cacheId,
              buildSummaryCacheEnvelope({
                text: tempData,
                context: cacheContext,
                model: payload.model,
                transcriptHash,
              }),
            )
            recordSummaryEvent({
              ...eventBase,
              event: 'summarize-success',
              latencyMs: Date.now() - startedAt,
              fallbackFrom: classified.kind,
              ...fallback.usage,
            })
            return
          } catch (fallbackError) {
            const fallbackClassified = classifyUpstreamError(fallbackError)
            recordSummaryEvent({
              ...eventBase,
              event: 'summarize-error',
              errorKind: fallbackClassified.kind,
              latencyMs: Date.now() - startedAt,
            })
            controller.error(new Error(`${fallbackClassified.kind}: ${fallbackClassified.message}`))
            return
          }
        }

        recordSummaryEvent({
          ...eventBase,
          event: 'summarize-error',
          errorKind: classified.kind,
          latencyMs: Date.now() - startedAt,
        })
        controller.error(new Error(`${classified.kind}: ${classified.message}`))
      }
    },
  })

  return stream
}
