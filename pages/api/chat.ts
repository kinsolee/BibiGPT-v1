import type { NextApiRequest, NextApiResponse } from 'next'
import { buildSummarizeOpenAIPayload, SummarizeRequestError } from '~/lib/openai/buildSummarizeRequest'
import { fetchOpenAIResult } from '~/lib/openai/fetchOpenAIResult'
import { selectApiKeyAndActivatedLicenseKey } from '~/lib/openai/selectApiKeyAndActivatedLicenseKey'
import { classifyUpstreamError } from '~/lib/models/errors'
import { SummarizeParams } from '~/lib/types'
import { persistChatHistory, resolveHistoryUser } from '~/lib/history/persistChatHistory'
import { writeWebStreamToNodeResponse } from '~/lib/openai/writeWebStreamToNodeResponse'

if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_COMPATIBLE_API_KEY) {
  throw new Error('Missing env var for OpenAI-compatible provider API key')
}

type ChatBody = Partial<SummarizeParams> & {
  messages?: Array<{ role: string; content?: string }>
}

function toHttpErrorMessage(statusCode: number, message: string) {
  return `${statusCode}::${message}`
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).send(toHttpErrorMessage(405, 'Method Not Allowed'))
  }

  const { videoConfig, userConfig } = req.body as ChatBody
  if (!videoConfig || !userConfig) {
    return res.status(400).send(toHttpErrorMessage(400, 'Missing videoConfig or userConfig'))
  }

  try {
    const { openAiPayload, userKey, baseUrl, cacheContext, videoId, title, subtitlesArray, descriptionText } =
      await buildSummarizeOpenAIPayload({ videoConfig, userConfig })
    const openaiApiKey = await selectApiKeyAndActivatedLicenseKey(userKey, videoId)
    const streamResult = await fetchOpenAIResult(
      { ...openAiPayload, stream: true },
      openaiApiKey,
      videoConfig,
      baseUrl,
      cacheContext,
    )
    // 在响应写出前解析会话，避免流式结束后 auth-helpers 无法写 cookie
    const historyUser = await resolveHistoryUser(req, res)
    const persistParams = {
      historyUser,
      videoConfig,
      shouldShowTimestamp: userConfig?.shouldShowTimestamp,
      videoId,
      title,
      subtitlesArray,
      descriptionText,
      model: openAiPayload.model,
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')

    if (streamResult instanceof ReadableStream) {
      const finalText = await writeWebStreamToNodeResponse(streamResult, res)
      await persistChatHistory({ ...persistParams, summaryText: finalText })
      return
    }

    res.status(200).send(streamResult)
    await persistChatHistory({ ...persistParams, summaryText: String(streamResult) })
  } catch (error: any) {
    if (error instanceof SummarizeRequestError) {
      console.error(error.message)
      return res.status(error.statusCode).send(toHttpErrorMessage(error.statusCode, error.message))
    }
    const classified = classifyUpstreamError(error)
    console.error(`${classified.kind}: ${classified.message}`)
    res
      .status(classified.httpStatus)
      .send(toHttpErrorMessage(classified.httpStatus, `${classified.kind}: ${classified.message}`))
  }
}
