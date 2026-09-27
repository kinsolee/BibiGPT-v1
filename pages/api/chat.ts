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
import { ChatAskError, prepareChatAsk } from '~/lib/chat/ask'
import type { ChatSourceKey } from '~/lib/chat/types'

if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_COMPATIBLE_API_KEY) {
  throw new Error('Missing env var for OpenAI-compatible provider API key')
}

type ChatBody = Partial<SummarizeParams> & {
  messages?: Array<{ role: string; content?: string }>
  /** KIN-43：携带该字段时走视频内追问链路，否则保持原摘要行为 */
  chatRequest?: {
    service?: string
    videoId?: string
    pageNumber?: null | string
    message?: string
  }
}

function toHttpErrorMessage(statusCode: number, message: string) {
  return `${statusCode}::${message}`
}

/** KIN-43 视频内追问：消费持久化 messages 做多轮问答，返回带 [mm:ss] 引用的流式回答 */
async function handleChatAsk(req: NextApiRequest, res: NextApiResponse, body: ChatBody) {
  const { service, videoId, pageNumber, message } = body.chatRequest ?? {}
  if (!service || !videoId || !message?.trim()) {
    return res.status(400).send(toHttpErrorMessage(400, 'Missing service, videoId or message in chatRequest'))
  }
  // 会话解析必须在流式输出前完成：auth-helpers 需要在 res 上写会话 cookie
  const historyUser = await resolveHistoryUser(req, res)
  if (!historyUser) {
    return res.status(401).send(toHttpErrorMessage(401, '登录后才能对视频追问'))
  }

  try {
    const prepared = await prepareChatAsk({
      supabase: historyUser.supabase,
      userId: historyUser.userId,
      source: { service, videoId, pageNumber: pageNumber ? String(pageNumber) : null } as ChatSourceKey,
      question: message.trim(),
      videoConfig: body.videoConfig,
      userConfig: body.userConfig,
    })

    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')

    let finalText = ''
    let streamCompleted = true
    if (prepared.streamResult instanceof ReadableStream) {
      const { tracked, completed } = trackCleanEnd(prepared.streamResult)
      finalText = await writeWebStreamToNodeResponse(tracked, res)
      streamCompleted = completed()
    } else {
      finalText = String(prepared.streamResult)
      res.status(200).send(finalText)
    }

    // provider 错误页/HTML 不落库；流中途失败（socket 已 destroy）同样不落库
    if (streamCompleted && isValidSummaryText(finalText)) {
      await prepared.persist(finalText)
    }
  } catch (error: any) {
    if (error instanceof ChatAskError) {
      console.error(`[chat-ask] ${error.statusCode}: ${error.message}`)
      return res.status(error.statusCode).send(toHttpErrorMessage(error.statusCode, error.message))
    }
    const classified = classifyUpstreamError(error)
    console.error(`[chat-ask] ${classified.kind}: ${classified.message}`)
    res
      .status(classified.httpStatus)
      .send(toHttpErrorMessage(classified.httpStatus, `${classified.kind}: ${classified.message}`))
  }
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

/**
 * 包一层流以区分「完整结束」与「中途失败」：writeWebStreamToNodeResponse
 * 在流错误时也会返回已收到的半截文本，chat 链路必须只在 clean end 后落库，
 * 保证流式失败不会把半个回答持久化。
 */
function trackCleanEnd(stream: ReadableStream<Uint8Array>): {
  tracked: ReadableStream<Uint8Array>
  completed: () => boolean
} {
  let clean = false
  const tracked = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          controller.enqueue(value)
        }
        clean = true
        controller.close()
      } catch (error) {
        controller.error(error)
      } finally {
        reader.releaseLock()
      }
    },
  })
  return { tracked, completed: () => clean }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).send(toHttpErrorMessage(405, 'Method Not Allowed'))
  }

  const body = req.body as ChatBody
  if (body.chatRequest) {
    return handleChatAsk(req, res, body)
  }

  const { videoConfig, userConfig } = body
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
        // 异步入队也要写 chat history：返回前先解析会话（auth-helpers 需要
        // 在 res 结束前写 cookie），job 完成后在 onCompleted 回调中落库
        const historyUser = await resolveHistoryUser(req, res)
        const { jobId } = await startSummaryJobInBackground(jobInput, {
          onCompleted: async (result) => {
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
          },
        })
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
