// KIN-47 导出 API 公共辅助：统一 { error: { code, message } } 错误结构与日志脱敏。
import type { NextApiResponse } from 'next'
import { toExportError } from './errors'

export function sendExportError(res: NextApiResponse, error: unknown): void {
  const exportError = toExportError(error)
  if (exportError.httpStatus >= 500) {
    console.error(`export api error [${exportError.code}]:`, exportError.message)
  }
  res.status(exportError.httpStatus).json({ error: { code: exportError.code, message: exportError.message } })
}

export function methodNotAllowed(res: NextApiResponse, allow: string[]): void {
  res.setHeader('Allow', allow.join(', '))
  res.status(405).json({ error: { code: 'method_not_allowed', message: `仅支持 ${allow.join('/')}` } })
}

export function bodyString(body: unknown, key: string): string | null {
  const value = (body as Record<string, unknown> | null)?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
