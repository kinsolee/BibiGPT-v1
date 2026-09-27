import type { NextApiRequest, NextApiResponse } from 'next'

/**
 * 上传/ingest 管线鉴权（自用版）：配置 BIBI_UPLOAD_TOKEN 时校验
 * `x-upload-token` 头或 `?uploadToken=`；未配置时只放行本机回环请求，
 * 防止部署到非回环地址后上传口裸奔。
 */
export function requireUploadAuth(req: NextApiRequest, res: NextApiResponse): boolean {
  const expected = process.env.BIBI_UPLOAD_TOKEN?.trim()
  if (expected) {
    const provided =
      (req.headers['x-upload-token'] as string | undefined)?.trim() || String(req.query.uploadToken ?? '')
    if (provided !== expected) {
      res.status(401).json({ errorMessage: 'invalid upload token' })
      return false
    }
    return true
  }

  const remote = req.socket.remoteAddress || ''
  const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
  if (!loopback) {
    res.status(403).json({
      errorMessage: 'upload API restricted to loopback; set BIBI_UPLOAD_TOKEN to expose it',
    })
    return false
  }
  return true
}
