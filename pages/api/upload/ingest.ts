import type { NextApiRequest, NextApiResponse } from 'next'

import { IngestHttpError, runIngest } from '~/lib/sources/adapters/ingest'
import type { IngestOptions } from '~/lib/sources/adapters/ingest'
import { requireUploadAuth } from '~/lib/storage/uploadAuth'

export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
  },
}

/**
 * KIN-46 新来源 ingest：POST { fileId? | sourceUrl?, mode?: 'transcript'|'summary', ...选项 }
 * - transcript（默认）：返回 MediaDocument + subtitleItems（/api/sumup 摘要输入同款契约）
 * - summary：单 chunk 走 fast 同步；多 chunk 复用 KIN-39 job 管线（BIBI_JOB_ASYNC_RETURN=1 时 202 轮询）
 * 错误 fail closed：SourceError → { errorMessage: `${code}: ...`, errorCode }
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!requireUploadAuth(req, res)) {
    return
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ errorMessage: 'Method Not Allowed' })
  }

  const body = (req.body ?? {}) as Record<string, unknown>
  const input = {
    fileId: body.fileId ? String(body.fileId) : undefined,
    sourceUrl: body.sourceUrl ? String(body.sourceUrl) : undefined,
  }
  const options: IngestOptions = {
    mode: body.mode === 'summary' ? 'summary' : 'transcript',
    userKey: body.userKey ? String(body.userKey) : undefined,
    baseUrl: body.baseUrl ? String(body.baseUrl) : undefined,
    model: body.model ? String(body.model) : undefined,
    shouldShowTimestamp: Boolean(body.shouldShowTimestamp),
    outputLanguage: body.outputLanguage ? String(body.outputLanguage) : undefined,
    sentenceNumber: Number.isFinite(Number(body.sentenceNumber)) ? Number(body.sentenceNumber) : undefined,
    showEmoji: body.showEmoji === undefined ? undefined : Boolean(body.showEmoji),
    detailLevel: Number.isFinite(Number(body.detailLevel)) ? Number(body.detailLevel) : undefined,
    outlineLevel: Number.isFinite(Number(body.outlineLevel)) ? Number(body.outlineLevel) : undefined,
  }

  try {
    const result = await runIngest(input, options)
    if (result.summary && result.summary.plan === 'job' && !result.summary.text) {
      return res.status(202).json({
        ...result,
        summary: { plan: 'job', jobId: result.summary.jobId },
        poll: `/api/sumup?jobId=${result.summary.jobId}`,
      })
    }
    return res.status(200).json(result)
  } catch (error: any) {
    if (error instanceof IngestHttpError) {
      const payload: Record<string, unknown> = { errorMessage: error.message }
      if (error.errorCode) {
        payload.errorCode = error.errorCode
      }
      return res.status(error.statusCode).json(payload)
    }
    console.error(`[upload/ingest] failed: ${error?.message}`)
    return res.status(500).json({ errorMessage: 'ingest failed' })
  }
}
