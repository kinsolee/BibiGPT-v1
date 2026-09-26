import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { ModelMessage, generateText, streamText } from 'ai'
import { Redis } from '@upstash/redis'
import { classifyUpstreamError } from '~/lib/models/errors'
import { CacheIdContext } from '~/lib/models/types'
import { normalizeBaseUrl } from '~/lib/models/registry'
import { trimOpenAiResult } from '~/lib/openai/trimOpenAiResult'
import { VideoConfig } from '~/lib/types'
import { isDev } from '~/utils/env'
import { getCacheId } from '~/utils/getCacheId'

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

async function generateTextFallback(params: {
  model: ReturnType<ReturnType<typeof createProvider>['chatModel']>
  messages: ModelMessage[]
  payload: OpenAIStreamPayload
}) {
  const result = await generateText({
    model: params.model,
    messages: params.messages,
    maxOutputTokens: params.payload.max_tokens,
    temperature: params.payload.temperature,
    topP: params.payload.top_p,
    frequencyPenalty: params.payload.frequency_penalty,
    presencePenalty: params.payload.presence_penalty,
  })

  return trimOpenAiResult(result.text)
}

async function cacheCompletedResult(redis: Redis, cacheId: string, text: string) {
  // Errors and half-finished summaries must never pollute the cache.
  if (!text.trim()) {
    console.warn(`skip caching empty result for ${cacheId}`)
    return
  }
  const data = await redis.set(cacheId, text)
  console.info(`video ${cacheId} cached:`, data)
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
  const provider = createProvider(resolvedApiKey, baseUrl)
  const model = provider.chatModel(payload.model)
  const messages = toModelMessages(payload.messages)

  const redis = Redis.fromEnv()
  const cacheId = getCacheId(videoConfig, cacheContext)
  console.info(`[summarize] model=${payload.model} stream=${payload.stream} cacheId=${cacheId}`)

  if (!payload.stream) {
    const betterResult = await generateTextFallback({ model, messages, payload })

    await cacheCompletedResult(redis, cacheId, betterResult)
    isDev && console.log('========betterResult========', betterResult)

    return betterResult
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
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const textPart of result.textStream) {
          tempData += textPart
          controller.enqueue(encoder.encode(textPart))
        }

        // Edge runtime can fail to decode provider stream in some environments.
        // If stream finished but emitted no usable content, fallback to non-stream.
        if (!tempData.trim() && fallbackAttempts < MAX_FALLBACK_ATTEMPTS) {
          fallbackAttempts += 1
          const fallbackText = await generateTextFallback({ model, messages, payload })
          if (fallbackText) {
            tempData = fallbackText
            controller.enqueue(encoder.encode(fallbackText))
          }
        }

        controller.close()
        await cacheCompletedResult(redis, cacheId, tempData)
        isDev && console.log('========betterResult after streamed========', tempData)
      } catch (streamError) {
        const classified = classifyUpstreamError(streamError)
        console.error(`[summarize] stream failed cacheId=${cacheId} kind=${classified.kind}: ${classified.message}`)

        // Only degrade to non-stream when nothing was emitted yet; appending a
        // full retry after partial content would duplicate output.
        if (!tempData.trim() && fallbackAttempts < MAX_FALLBACK_ATTEMPTS) {
          fallbackAttempts += 1
          try {
            const fallbackText = await generateTextFallback({ model, messages, payload })
            tempData = fallbackText
            controller.enqueue(encoder.encode(fallbackText))
            controller.close()
            await cacheCompletedResult(redis, cacheId, tempData)
            isDev && console.warn('stream failed, used fallback generateText', classified.kind)
            return
          } catch (fallbackError) {
            const fallbackClassified = classifyUpstreamError(fallbackError)
            console.error(
              `[summarize] fallback failed cacheId=${cacheId} kind=${fallbackClassified.kind}: ${fallbackClassified.message}`,
            )
            controller.error(new Error(`${fallbackClassified.kind}: ${fallbackClassified.message}`))
            return
          }
        }

        controller.error(new Error(`${classified.kind}: ${classified.message}`))
      }
    },
  })

  return stream
}
