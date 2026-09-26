import type { NextApiRequest, NextApiResponse } from 'next'
import { buildSummarizeOpenAIPayload, SummarizeRequestError, toJobChunkSpecs } from '~/lib/openai/buildSummarizeRequest'
import { fetchOpenAIResult } from '~/lib/openai/fetchOpenAIResult'
import { selectApiKeyAndActivatedLicenseKey } from '~/lib/openai/selectApiKeyAndActivatedLicenseKey'
import { classifyUpstreamError } from '~/lib/models/errors'
import { SummarizeParams } from '~/lib/types'
import { writeWebStreamToNodeResponse } from '~/lib/openai/writeWebStreamToNodeResponse'
import { JobFailureError } from '~/lib/jobs/engine'
import { jobErrorToHttpStatus } from '~/lib/jobs/errors'
import { getSharedJobEngine, runSummaryToCompletion } from '~/lib/jobs/summaryJob'
import { JobSnapshot } from '~/lib/jobs/types'

if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_COMPATIBLE_API_KEY) {
  throw new Error('Missing env var for OpenAI-compatible provider API key')
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

function toJobStatusJson(snapshot: JobSnapshot, includeResult: boolean) {
  const { record, steps } = snapshot
  return {
    job: {
      id: record.id,
      status: record.status,
      videoId: record.videoId,
      model: record.params.model,
      provider: record.params.provider,
      attempt: record.attempt,
      chunkCount: record.params.chunks.length,
      checkpoint: record.checkpoint,
      error: record.error,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      finishedAt: record.finishedAt,
      ...(includeResult ? { resultText: record.resultText } : {}),
    },
    steps: steps.map((step) => ({
      index: step.index,
      kind: step.kind,
      chunkIndex: step.chunkIndex,
      status: step.status,
      attempt: step.attempt,
      error: step.error,
      outputBytes: step.output.length,
    })),
  }
}

/** GET：job 状态查询（?jobId=...，可选 includeResult=1）与失败队列列表（?list=failed） */
async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const engine = getSharedJobEngine()
  const { jobId, list, includeResult, olderThanMs } = req.query

  if (jobId && typeof jobId === 'string') {
    const snapshot = await engine.getJob(jobId)
    if (!snapshot) {
      return res.status(404).json({ errorMessage: `job not found: ${jobId}` })
    }
    return res.status(200).json(toJobStatusJson(snapshot, includeResult === '1'))
  }

  if (list === 'failed') {
    const threshold = olderThanMs && /^\d+$/.test(String(olderThanMs)) ? Number(olderThanMs) : undefined
    return res.status(200).json({ jobIds: await engine.listFailedJobs(threshold) })
  }

  if (list === 'active') {
    return res.status(200).json({ jobIds: await engine.listActiveJobs() })
  }

  return res.status(400).json({ errorMessage: 'Missing query: use ?jobId=... or ?list=failed|active' })
}

type SumupBody = Partial<SummarizeParams> & {
  action?: 'cancelJob' | 'cleanupJobs'
  jobId?: string
  olderThanMs?: number
}

/** POST action 分支：job 取消与失败队列清理（不影响既有摘要请求契约） */
async function handleAction(body: SumupBody, res: NextApiResponse) {
  const engine = getSharedJobEngine()
  if (body.action === 'cancelJob') {
    if (!body.jobId) {
      return res.status(400).json({ errorMessage: 'Missing jobId for cancelJob' })
    }
    const canceled = await engine.cancel(body.jobId)
    return res.status(200).json({ jobId: body.jobId, canceled })
  }
  if (body.action === 'cleanupJobs') {
    const removed = await engine.cleanupFailedJobs(body.olderThanMs)
    return res.status(200).json({ removed })
  }
  return res.status(400).json({ errorMessage: `Unknown action: ${body.action}` })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return handleGet(req, res).catch((error: any) => {
      console.error(`[sumup] job query failed: ${error?.message}`)
      return res.status(500).json({ errorMessage: 'job query failed' })
    })
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST')
    return res.status(405).json({ errorMessage: 'Method Not Allowed' })
  }

  const body = req.body as SumupBody
  if (body?.action === 'cancelJob' || body?.action === 'cleanupJobs') {
    return handleAction(body, res).catch((error: any) => {
      console.error(`[sumup] job action failed: ${error?.message}`)
      return res.status(500).json({ errorMessage: 'job action failed' })
    })
  }

  const summarizeParams = body as Partial<SummarizeParams>
  if (!summarizeParams?.videoConfig || !summarizeParams?.userConfig) {
    return res.status(400).json({ errorMessage: 'Missing videoConfig or userConfig' })
  }

  try {
    const normalizedParams = summarizeParams as SummarizeParams
    const { videoConfig, userConfig } = normalizedParams
    const { openAiPayload, userKey, baseUrl, cacheContext, videoId, title, plan, chunks, modelTarget, detailTokens } =
      await buildSummarizeOpenAIPayload(normalizedParams)

    // 长视频：多 chunk map-reduce job；成功后按 enableStream 决定流式回写或 JSON 返回
    if (plan === 'job') {
      const apiKey = await selectApiKeyAndActivatedLicenseKey(userKey, videoId)
      const result = await runSummaryToCompletion({
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
      })
      if (videoConfig.enableStream ?? true) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('X-Bibi-Job-Id', result.jobId)
        await writeWebStreamToNodeResponse(summaryTextToStream(result.summaryText), res)
        return
      }
      return res.status(200).json(result.summaryText)
    }

    const openaiApiKey = await selectApiKeyAndActivatedLicenseKey(userKey, videoId)
    const result = await fetchOpenAIResult(openAiPayload, openaiApiKey, videoConfig, baseUrl, cacheContext)

    if (openAiPayload.stream) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      if (result instanceof ReadableStream) {
        await writeWebStreamToNodeResponse(result, res)
        return
      }
      res.status(200).send(result)
      return
    }

    res.status(200).json(result)
  } catch (error: any) {
    if (error instanceof SummarizeRequestError) {
      return res.status(error.statusCode).json({ errorMessage: error.message })
    }
    if (error instanceof JobFailureError) {
      console.error(`[sumup] job failed (${error.code}): ${error.message}`)
      const statusCode = jobErrorToHttpStatus(error.code)
      return res.status(statusCode).json({
        errorMessage: `${error.code}: ${error.message}`,
        errorCode: error.code,
      })
    }
    const classified = classifyUpstreamError(error)
    console.error(`${classified.kind}: ${classified.message}`)
    return res.status(classified.httpStatus).json({
      errorMessage: `${classified.kind}: ${classified.message}`,
      errorCode: classified.kind,
    })
  }
}
