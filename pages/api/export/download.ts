import type { NextApiRequest, NextApiResponse } from 'next'
import { requireUserId } from '~/lib/history/server'
import { auditAction } from '~/lib/export/service'
import { buildExportSpec } from '~/lib/export/spec'
import { parseDownloadToken, verifyDownloadToken } from '~/lib/export/crypto'
import { renderExport } from '~/lib/export/render'
import { isExportFormat } from '~/lib/export/types'
import { sendExportError } from '~/lib/export/api'

/**
 * GET /api/export/download?c=&f=&u=&e=&s=
 * 权限模型（自用版简化口径）：会话归属 + HMAC 签名 + 过期时间三重校验；
 * render 端点已验证 content 归属，这里用 token 里的 userId 与会话比对防链接转让。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: { code: 'method_not_allowed', message: '仅支持 GET' } })
  }
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  try {
    const token = parseDownloadToken(req.query)
    if (!token) {
      return res.status(400).json({ error: { code: 'invalid_token', message: '下载链接参数不完整' } })
    }
    if (token.payload.userId !== auth.userId) {
      return res.status(403).json({ error: { code: 'token_owner_mismatch', message: '下载链接与当前用户不一致' } })
    }
    if (!verifyDownloadToken(token.payload, token.signature)) {
      return res
        .status(403)
        .json({ error: { code: 'token_expired_or_invalid', message: '下载链接已过期或不合法，请重新导出' } })
    }
    if (!isExportFormat(token.payload.format)) {
      return res.status(400).json({ error: { code: 'invalid_format', message: 'format 不合法' } })
    }
    const spec = await buildExportSpec(auth.supabase, auth.userId, { contentId: token.payload.contentId })
    const rendered = await renderExport(spec, token.payload.format)
    await auditAction(auth.supabase, auth.userId, 'download', {
      contentId: token.payload.contentId,
      metadata: { format: token.payload.format },
    })

    const asciiName = rendered.filename.replace(/[^\x20-\x7E]/g, '_') || 'export'
    res.setHeader('Content-Type', rendered.mime)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rendered.filename)}`,
    )
    res.setHeader('Cache-Control', 'private, no-store')
    res.status(200).send(rendered.body)
  } catch (error) {
    sendExportError(res, error)
  }
}
