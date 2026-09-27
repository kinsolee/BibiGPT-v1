import type { NextApiRequest, NextApiResponse } from 'next'
import { requireUserId } from '~/lib/history/server'
import { listDeliveries } from '~/lib/export/service'
import { methodNotAllowed, sendExportError } from '~/lib/export/api'

/** GET /api/export/deliveries?contentId=|videoUrl=&pageNumber=&limit=：投递历史（含失败，供重试） */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    methodNotAllowed(res, ['GET'])
    return
  }
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  try {
    const query = req.query
    const limit = typeof query.limit === 'string' ? Number(query.limit) : undefined
    const items = await listDeliveries(auth.supabase, auth.userId, {
      contentId: typeof query.contentId === 'string' ? query.contentId : null,
      videoUrl: typeof query.videoUrl === 'string' ? query.videoUrl : null,
      pageNumber: typeof query.pageNumber === 'string' ? query.pageNumber : null,
      limit: Number.isFinite(limit) ? limit : undefined,
    })
    return res.status(200).json({ items })
  } catch (error) {
    sendExportError(res, error)
  }
}
