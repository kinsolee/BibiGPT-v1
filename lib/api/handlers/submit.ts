import type { NextApiRequest, NextApiResponse } from 'next'
import type { V1Deps } from '../deps'
import { V1Error } from '../errors'
import { applyV1Cors, readJsonBody, sendV1MethodNotAllowed } from '../http'
import { authenticateV1, checkRateLimit, requireWriteScope, withV1Idempotency } from './common'

export interface V1SubmitOptions {
  model?: string
  language?: string
}

export interface V1SubmitInput {
  userId: string
  sourceUrl: string
  options?: V1SubmitOptions
}

export interface V1SubmitOutcome {
  jobId: string
  contentId: string | null
  reused: boolean
}

/**
 * submit 管线由路由层注入：handler 保持纯净（fixture 可注入 fake），
 * 默认实现在 lib/api/pipeline.ts（抓字幕 → 组 job → 入队/复用 → 解析 contentId）。
 * 管线只允许抛 V1Error。
 */
export type V1SubmitPipeline = (input: V1SubmitInput) => Promise<V1SubmitOutcome>

/** POST /api/v1/submit — body { sourceUrl, options? } → 202 { jobId, contentId, reused } */
export async function handleV1Submit(
  req: NextApiRequest,
  res: NextApiResponse,
  deps: V1Deps,
  pipeline: V1SubmitPipeline,
): Promise<void> {
  if (applyV1Cors(req, res)) {
    return
  }
  if (req.method !== 'POST') {
    sendV1MethodNotAllowed(res, 'POST')
    return
  }
  const auth = await authenticateV1(req, res, deps)
  if (!auth) {
    return
  }
  if (!requireWriteScope(auth, res)) {
    return
  }
  if (!(await checkRateLimit(auth, res, deps.rateLimiter))) {
    return
  }
  const body = readJsonBody(req)
  await withV1Idempotency(req, res, deps.idempotencyStore, auth, 'submit', async () => {
    const parsed = parseSubmitBody(body)
    if (typeof parsed === 'string') {
      return {
        status: 400,
        body: { error: { code: 'INVALID_REQUEST', message: parsed } },
      }
    }
    try {
      const outcome = await pipeline({ userId: auth.userId, sourceUrl: parsed.sourceUrl, options: parsed.options })
      return { status: 202, body: outcome }
    } catch (error) {
      if (error instanceof V1Error) {
        return {
          status: error.httpStatus,
          body: {
            error: {
              code: error.code,
              message: error.message,
              ...(error.details !== undefined ? { details: error.details } : {}),
            },
          },
        }
      }
      return {
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'submit failed unexpectedly' } },
      }
    }
  })
}

/** body 校验：返回错误 message 字符串或规范化后的输入 */
function parseSubmitBody(body: unknown): { sourceUrl: string; options?: V1SubmitOptions } | string {
  if (typeof body !== 'object' || body === null) {
    return 'request body must be a JSON object with a sourceUrl string'
  }
  const { sourceUrl, options } = body as { sourceUrl?: unknown; options?: unknown }
  if (typeof sourceUrl !== 'string' || !sourceUrl.trim()) {
    return 'sourceUrl is required and must be a non-empty string'
  }
  if (options === undefined) {
    return { sourceUrl: sourceUrl.trim() }
  }
  if (typeof options !== 'object' || options === null) {
    return 'options must be an object'
  }
  const { model, language } = options as { model?: unknown; language?: unknown }
  if (model !== undefined && typeof model !== 'string') {
    return 'options.model must be a string'
  }
  if (language !== undefined && typeof language !== 'string') {
    return 'options.language must be a string'
  }
  return {
    sourceUrl: sourceUrl.trim(),
    options: {
      ...(model !== undefined ? { model } : {}),
      ...(language !== undefined ? { language } : {}),
    },
  }
}
