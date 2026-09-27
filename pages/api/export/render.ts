import type { NextApiRequest, NextApiResponse } from 'next'
import { requireUserId } from '~/lib/history/server'
import { auditAction } from '~/lib/export/service'
import { buildExportSpec, resolveContentRow } from '~/lib/export/spec'
import { buildDownloadUrl } from '~/lib/export/crypto'
import { buildExportFilename } from '~/lib/export/render'
import { ExportError } from '~/lib/export/errors'
import { isExportFormat, type ExportRenderResponse } from '~/lib/export/types'
import { bodyString, methodNotAllowed, sendExportError } from '~/lib/export/api'

const DOWNLOAD_TTL_MS = 10 * 60 * 1000

/** POST /api/export/render：构建 ExportSpec 并返回签名下载链接（不重生成，只读既有数据） */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    methodNotAllowed(res, ['POST'])
    return
  }
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  try {
    const format = bodyString(req.body, 'format')
    if (!isExportFormat(format)) {
      return res
        .status(400)
        .json({ error: { code: 'invalid_format', message: 'format 必须是 markdown/json/pdf/docx' } })
    }
    const params = {
      contentId: bodyString(req.body, 'contentId'),
      videoUrl: bodyString(req.body, 'videoUrl'),
      pageNumber: bodyString(req.body, 'pageNumber'),
    }
    const content = await resolveContentRow(auth.supabase, auth.userId, params)
    if (!content) {
      throw new ExportError('content_not_found', 404, '内容不存在或不属于当前用户')
    }
    const spec = await buildExportSpec(auth.supabase, auth.userId, params)
    const exp = Date.now() + DOWNLOAD_TTL_MS
    const downloadUrl = buildDownloadUrl('/api/export/download', {
      contentId: content.id,
      format,
      userId: auth.userId,
      exp,
    })
    await auditAction(auth.supabase, auth.userId, 'render', { contentId: content.id, metadata: { format } })
    const response: ExportRenderResponse = {
      downloadUrl,
      expiresAt: new Date(exp).toISOString(),
      format,
      filename: buildExportFilename(spec, format),
    }
    return res.status(200).json(response)
  } catch (error) {
    sendExportError(res, error)
  }
}
