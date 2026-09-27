import type { NextApiRequest, NextApiResponse } from 'next'

/**
 * /api/v1 各端点共用的 CORS 预处理：浏览器扩展 popup / web 客户端跨域调用时需要。
 * 返回 true 表示请求已处理（OPTIONS 预检），调用方应立即 return。
 */
export function applyV1Cors(req: NextApiRequest, res: NextApiResponse): boolean {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key')
  res.setHeader('Access-Control-Max-Age', '86400')
  res.setHeader('Vary', 'Origin')
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return true
  }
  return false
}

/** 405 与统一错误码的折中：契约错误码枚举没有 405 专属 code，复用 INVALID_REQUEST 并在 message 说明 */
export function sendV1MethodNotAllowed(res: NextApiResponse, allowed: string): void {
  res.setHeader('Allow', allowed)
  res.status(405).json({ error: { code: 'INVALID_REQUEST', message: `Method Not Allowed (allowed: ${allowed})` } })
}

/** Next 已按 Content-Type 解析 JSON body；兜底处理字符串形态与空 body */
export function readJsonBody(req: NextApiRequest): unknown {
  const body = req.body
  if (body === undefined || body === null || body === '') {
    return null
  }
  if (typeof body === 'string') {
    try {
      return JSON.parse(body)
    } catch {
      return null
    }
  }
  return body
}

export function readHeaderString(req: NextApiRequest, name: string): string | undefined {
  const value = req.headers[name]
  if (Array.isArray(value)) {
    return value[0]?.trim() || undefined
  }
  return value?.trim() || undefined
}
