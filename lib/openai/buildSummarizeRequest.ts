import { fetchSubtitle } from '~/lib/fetchSubtitle'
import { ChatGPTAgent, OpenAIStreamPayload } from '~/lib/openai/fetchOpenAIResult'
import { getSmallSizeTranscripts } from '~/lib/openai/getSmallSizeTranscripts'
import { getUserSubtitlePrompt, getUserSubtitleWithTimestampPrompt } from '~/lib/openai/prompt'
import {
  isLikelyThinkingModel,
  resolveCacheIdContext,
  resolveModelTarget,
  THINKING_MODEL_MIN_OUTPUT_TOKENS,
} from '~/lib/models/registry'
import { CacheIdContext } from '~/lib/models/types'
import { SummarizeParams } from '~/lib/types'
import { isDev } from '~/utils/env'

export class SummarizeRequestError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'SummarizeRequestError'
    this.statusCode = statusCode
  }
}

export async function buildSummarizeOpenAIPayload({ videoConfig, userConfig }: SummarizeParams): Promise<{
  openAiPayload: OpenAIStreamPayload
  userKey?: string
  baseUrl?: string
  cacheContext: CacheIdContext
  modelTarget: ReturnType<typeof resolveModelTarget>
  videoId: string
}> {
  const { userKey, baseUrl, shouldShowTimestamp } = userConfig || {}
  const { videoId } = videoConfig

  if (!videoId) {
    throw new SummarizeRequestError(500, 'No videoId in the request')
  }

  const { title, subtitlesArray, descriptionText } = await fetchSubtitle(videoConfig, shouldShowTimestamp)
  if (!subtitlesArray && !descriptionText) {
    console.error('No subtitle in the video: ', videoId)
    throw new SummarizeRequestError(501, 'No subtitle in the video')
  }

  const inputText = subtitlesArray ? getSmallSizeTranscripts(subtitlesArray, subtitlesArray) : descriptionText

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

  return { openAiPayload, userKey, baseUrl: modelTarget.baseUrl, cacheContext, modelTarget, videoId }
}
