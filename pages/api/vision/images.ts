import type { NextApiRequest, NextApiResponse } from 'next'

import { requireUserId } from '~/lib/history/server'
import { fetchImageNoteImages } from '~/lib/vision/images'
import { resolveVisionContent } from '~/lib/vision/media'
import type { MediaImage } from '~/lib/sources/types'

/**
 * GET /api/vision/images?videoUrl=...
 * 图文笔记图片：实时拉来源 adapter（XHS/抖音/微信/YouTube 封面/播客封面…），
 * 成功即缓存；来源失败回退缓存，保证重新打开仍显示原图。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'method_not_allowed' })
  }
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  const videoUrl = typeof req.query.videoUrl === 'string' ? req.query.videoUrl : ''
  if (!videoUrl) {
    return res.status(400).json({ error: 'bad_request', message: 'missing videoUrl' })
  }

  try {
    const content = await resolveVisionContent(auth.supabase, auth.userId, videoUrl)
    const result = await fetchImageNoteImages({
      supabase: auth.supabase,
      userId: auth.userId,
      videoUrl,
      content,
    })
    if (result.status === 'unavailable') {
      return res.status(200).json({
        status: 'unavailable',
        contentId: result.contentId,
        service: null,
        sourceRef: null,
        images: [] as MediaImage[],
        reason: result.reason,
      })
    }
    return res.status(200).json({
      status: result.status,
      contentId: result.contentId || null,
      service: result.service,
      sourceRef: result.sourceRef,
      images: result.images,
    })
  } catch (error) {
    console.error('[vision] images fetch failed:', error)
    return res.status(500).json({
      error: 'internal_error',
      message: error instanceof Error ? error.message : '图片拉取失败',
    })
  }
}
