import type { NextApiResponse } from 'next'
import { sourceErrorCodeToHttpStatus } from '~/lib/sources/types'
import type { SourceErrorCode } from '~/lib/sources/types'

/**
 * /api/v1 统一错误 envelope 的错误码集合（KIN-49 契约锁定）：
 * HTTP 状态码 + { "error": { "code", "message", "details"? } }。
 */
export type V1ErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'UNSUPPORTED_SOURCE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RATE_LIMITED'
  | 'NO_TRANSCRIPT'
  | 'SOURCE_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'INTERNAL'

export const V1_ERROR_STATUS: Record<V1ErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UNSUPPORTED_SOURCE: 422,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_LIMITED: 429,
  NO_TRANSCRIPT: 501,
  SOURCE_UNAVAILABLE: 502,
  UPSTREAM_TIMEOUT: 504,
  INTERNAL: 500,
}

export class V1Error extends Error {
  readonly code: V1ErrorCode
  readonly details?: unknown

  constructor(code: V1ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'V1Error'
    this.code = code
    this.details = details
  }

  get httpStatus(): number {
    return V1_ERROR_STATUS[this.code]
  }
}

/** 按契约输出统一错误 envelope */
export function sendV1Error(res: NextApiResponse, error: V1Error): void {
  res.status(error.httpStatus).json({
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  })
}

/**
 * SourceErrorCode → v1 错误码。HTTP 语义与 lib/sources/types 的
 * sourceErrorCodeToHttpStatus 保持一致（NO_TRANSCRIPT→501、AUTH_REQUIRED→403、
 * SOURCE_UNAVAILABLE→502、RATE_LIMITED→429）。
 */
export function v1ErrorFromSourceCode(code: SourceErrorCode, message: string): V1Error {
  switch (sourceErrorCodeToHttpStatus(code)) {
    case 501:
      return new V1Error('NO_TRANSCRIPT', message)
    case 403:
      return new V1Error('FORBIDDEN', message)
    case 502:
      return new V1Error('SOURCE_UNAVAILABLE', message)
    case 429:
      return new V1Error('RATE_LIMITED', message)
    default:
      return new V1Error('INTERNAL', message)
  }
}
