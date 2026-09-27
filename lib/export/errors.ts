// KIN-47 导出模块错误：统一携带 HTTP 状态与结构化 code，日志层负责 redactSecrets。
import { redactSecrets } from '~/lib/models/errors'

export class ExportError extends Error {
  code: string
  httpStatus: number

  constructor(code: string, httpStatus: number, message: string) {
    super(redactSecrets(message))
    this.name = 'ExportError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

/** 把任意异常归一为 ExportError（provider 网络失败等），错误消息一律 redact */
export function toExportError(error: unknown, fallbackCode = 'internal_error'): ExportError {
  if (error instanceof ExportError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  return new ExportError(fallbackCode, 500, message || 'Internal Server Error')
}
