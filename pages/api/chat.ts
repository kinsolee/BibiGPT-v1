import type { NextApiRequest, NextApiResponse } from 'next'
import { buildSummarizeOpenAIPayload, SummarizeRequestError, toJobChunkSpecs } from '~/lib/openai/buildSummarizeRequest'
import { fetchOpenAIResult } from '~/lib/openai/fetchOpenAIResult'
import { selectApiKeyAndActivatedLicenseKey } from '~/lib/openai/selectApiKeyAndActivatedLicenseKey'
import { classifyUpstreamError } from '~/lib/models/errors'
import { SummarizeParams } from '~/lib/types'
import { persistChatHistory, resolveHistoryUser } from '~/lib/history/persistChatHistory'
import { writeWebStreamToNodeResponse } from '~/lib/openai/writeWebStreamToNodeResponse'
import { JobFailureError } from '~/lib/jobs/engine'
import { jobErrorToHttpStatus } from '~/lib/jobs/errors'
import { runSummaryToCompletion, startSummaryJobInBackground } from '~/lib/jobs/summaryJob'
import { isValidSummaryText } from '~/lib/jobs/validation'

if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_COMPATIBLE_API_KEY) {
  throw new Error('Missing env var for OpenAI-compatible provider API key')
}

type ChatBody = Partial<SummarizeParams> & {
  messages?: Array<{ role: string; content?: string }>
}

function toHttpErrorMessage(statusCode: number, message: string) {
  return `${statusCode}::${message}`
}

function summaryTextToStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
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
    const {
      openAiPayload,
      userKey,
      baseUrl,
      cacheContext,
      videoId,
      title,
      subtitlesArray,
      descriptionText,
      plan,
      chunks,
      modelTarget,
      detailTokens,
    } = await buildSummarizeOpenAIPayload({ videoConfig, userConfig })

    // 长视频：多 chunk map-reduce job（幂等、可续传、可取消）。
    // 默认同步驱动到终态后一次性流式回写全文（自托管 docker 无平台时限，
    // 前端契约是纯文本流）；BIBI_JOB_ASYNC_RETURN=1 时入队即返回 jobId，
    // 由调用方轮询 /api/sumup?jobId=（轮询属管理面，需 admin token）。
    if (plan === 'job') {
      const apiKey = await selectApiKeyAndActivatedLicenseKey(userKey, videoId)
      const jobInput = {
        videoConfig,
        userConfig,
        title,
        chunks: toJobChunkSpecs(chunks),
        model: modelTarget.model,
        provider: modelTarget.provider,
        baseUrl: modelTarget.baseUrl,
        promptVersion: cacheContext.promptVersion,
        detailTokens,
        apiKey,
      }
      if (process.env.BIBI_JOB_ASYNC_RETURN === '1') {
        const { jobId } = await startSummaryJobInBackground(jobInput)
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('X-Bibi-Job-Id', jobId)
        return res.status(202).send(JSON.stringify({ jobId, status: 'queued', poll: `/api/sumup?jobId=${jobId}` }))
      }
      const historyUser = await resolveHistoryUser(req, res)
      const result = await runSummaryToCompletion(jobInput)

      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('X-Bibi-Job-Id', result.jobId)
      await writeWebStreamToNodeResponse(summaryTextToStream(result.summaryText), res)

      if (isValidSummaryText(result.summaryText)) {
        await persistChatHistory({
          historyUser,
          videoConfig,
          shouldShowTimestamp: userConfig?.shouldShowTimestamp,
          videoId,
          title,
          subtitlesArray,
          descriptionText,
          model: modelTarget.model,
          summaryText: result.summaryText,
        })
      }
      return
    }

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
      // provider 错误页/HTML 不落库（流已按旧行为写出，仅拦截持久化）
      if (isValidSummaryText(finalText)) {
        await persistChatHistory({ ...persistParams, summaryText: finalText })
      }
      return
    }

    res.status(200).send(streamResult)
    if (isValidSummaryText(String(streamResult))) {
      await persistChatHistory({ ...persistParams, summaryText: String(streamResult) })
    }
  } catch (error: any) {
    if (error instanceof SummarizeRequestError) {
      console.error(error.message)
      return res.status(error.statusCode).send(toHttpErrorMessage(error.statusCode, error.message))
    }
    if (error instanceof JobFailureError) {
      console.error(`[chat] job failed (${error.code}): ${error.message}`)
      const statusCode = jobErrorToHttpStatus(error.code)
      return res.status(statusCode).send(toHttpErrorMessage(statusCode, `${error.code}: ${error.message}`))
    }
    const classified = classifyUpstreamError(error)
    console.error(`${classified.kind}: ${classified.message}`)
    res
      .status(classified.httpStatus)
      .send(toHttpErrorMessage(classified.httpStatus, `${classified.kind}: ${classified.message}`))
  }
}
