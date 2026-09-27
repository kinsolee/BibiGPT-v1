import type { NextApiRequest, NextApiResponse } from 'next'
import { loadArtifactBundle } from '~/lib/artifacts/bundle'
import { requireUserId } from '~/lib/history/server'

/** GET /api/artifacts?videoUrl=...[&pageNumber=...]：读取已落库的章节/重点/字幕 bundle，不触发生成 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }

  const videoUrl = typeof req.query.videoUrl === 'string' ? req.query.videoUrl : null
  const contentId = typeof req.query.contentId === 'string' ? req.query.contentId : null
  if (!videoUrl && !contentId) {
    return res.status(400).json({ error: 'bad_request', message: 'missing videoUrl or contentId' })
  }
  const pageNumber = typeof req.query.pageNumber === 'string' && req.query.pageNumber ? req.query.pageNumber : null

  try {
    const bundle = await loadArtifactBundle({
      supabase: auth.supabase,
      userId: auth.userId,
      videoUrl,
      pageNumber,
      contentId,
    })
    return res.status(200).json(bundle)
  } catch (error: any) {
    console.error('artifacts bundle load failed:', error)
    return res.status(500).json({ error: 'internal_error', message: error?.message ?? 'Internal Server Error' })
  }
}
