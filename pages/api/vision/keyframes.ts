import type { NextApiRequest, NextApiResponse } from 'next'

import { requireUserId } from '~/lib/history/server'
import { generateKeyframeSet } from '~/lib/vision/generate'
import { resolveVisionContent } from '~/lib/vision/media'
import { loadFrameAnalyses, loadKeyframeArtifact } from '~/lib/vision/persist'
import { sourceErrorCodeToHttpStatus, SourceError } from '~/lib/sources/types'
import type { KeyframeSetPayload } from '~/lib/vision/types'

export const config = { maxDuration: 300 }

function errorStatus(error: unknown): number {
  if (error instanceof SourceError) {
    return sourceErrorCodeToHttpStatus(error.code)
  }
  return 500
}

/** GET /api/vision/keyframes?videoUrl=...：读取已落库关键帧集合与帧分析，不触发生成 */
async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  const videoUrl = typeof req.query.videoUrl === 'string' ? req.query.videoUrl : ''
  if (!videoUrl) {
    return res.status(400).json({ error: 'bad_request', message: 'missing videoUrl' })
  }
  const pageNumber = typeof req.query.pageNumber === 'string' && req.query.pageNumber ? req.query.pageNumber : null
  try {
    const content = await resolveVisionContent(auth.supabase, auth.userId, videoUrl, pageNumber)
    if (!content) {
      return res.status(200).json({ found: false, contentId: '', payload: null, analyses: [] })
    }
    const artifact = await loadKeyframeArtifact(auth.supabase, content.id)
    const payload = (artifact?.payload as unknown as KeyframeSetPayload | undefined) ?? null
    const analyses = payload
      ? await loadFrameAnalyses(auth.supabase, content.id, payload.setId)
      : await loadFrameAnalyses(auth.supabase, content.id, null)
    return res.status(200).json({
      found: Boolean(payload),
      contentId: content.id,
      payload,
      analyses,
    })
  } catch (error) {
    console.error('[vision] keyframes load failed:', error)
    return res.status(errorStatus(error)).json({
      error: 'vision_error',
      message: error instanceof Error ? error.message : '读取关键帧失败',
    })
  }
}

/** POST /api/vision/keyframes：生成（或复用）关键帧集合；需先入库摘要，fail closed */
async function handlePost(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
    videoUrl?: string
    pageNumber?: string | null
    force?: boolean
  }
  const videoUrl = typeof body.videoUrl === 'string' ? body.videoUrl : ''
  if (!videoUrl) {
    return res.status(400).json({ error: 'bad_request', message: 'missing videoUrl' })
  }
  try {
    const content = await resolveVisionContent(auth.supabase, auth.userId, videoUrl, body.pageNumber ?? null)
    if (!content) {
      return res.status(404).json({
        error: 'CONTENT_NOT_PERSISTED',
        message: '该内容还没有入库摘要（登录后完成一次摘要，即可生成关键帧）',
      })
    }
    const result = await generateKeyframeSet({
      supabase: auth.supabase,
      userId: auth.userId,
      content,
      videoUrl,
      force: body.force !== false,
    })
    if (result.status === 'audio-only') {
      return res.status(200).json({
        mode: result.payload.mode,
        payload: result.payload,
        reused: result.reused,
        message: isAudioOnlyMessage(result.payload.mode),
      })
    }
    return res.status(200).json({ mode: result.payload.mode, payload: result.payload, reused: result.reused })
  } catch (error) {
    console.error('[vision] keyframes generate failed:', error)
    return res.status(errorStatus(error)).json({
      error: 'vision_error',
      message: error instanceof Error ? error.message : '关键帧生成失败',
    })
  }
}

function isAudioOnlyMessage(mode: string): string {
  return mode === 'audio-illustrations'
    ? '音频内容无视频帧，已按开关启用来源图片作为插图'
    : '音频内容没有视频帧；可配置 BIBI_VISION_AUDIO_ILLUSTRATIONS=true 启用插图'
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return handleGet(req, res)
  }
  if (req.method === 'POST') {
    return handlePost(req, res)
  }
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'method_not_allowed' })
}
