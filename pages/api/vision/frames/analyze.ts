import type { NextApiRequest, NextApiResponse } from 'next'

import { requireUserId } from '~/lib/history/server'
import { analyzeFrameBatch } from '~/lib/vision/analyze'
import { loadFrameAnalyses, loadKeyframeArtifact } from '~/lib/vision/persist'
import { resolveVisionContent } from '~/lib/vision/media'
import { sourceErrorCodeToHttpStatus, SourceError } from '~/lib/sources/types'
import type { AnalyzeFrameRef } from '~/lib/vision/analyze'
import type { FrameAnalysisPayload, KeyframeSetPayload } from '~/lib/vision/types'

export const config = { maxDuration: 300 }

/**
 * POST /api/vision/frames/analyze
 * body: { videoUrl, frameId?/imageUrl?/imageId?, force? }
 * - frameId：分析已落库关键帧集合里的指定帧；省略则分析全部帧
 * - imageUrl(+imageId)：分析图文笔记/插图等外部图片
 * 逐帧隔离错误；(frameHash, model) 缓存命中不重复调 VLM。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method_not_allowed' })
  }
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
    videoUrl?: string
    frameId?: string | null
    imageUrl?: string | null
    imageId?: string | null
    force?: boolean
  }
  const videoUrl = typeof body.videoUrl === 'string' ? body.videoUrl : ''
  if (!videoUrl) {
    return res.status(400).json({ error: 'bad_request', message: 'missing videoUrl' })
  }

  try {
    const content = await resolveVisionContent(auth.supabase, auth.userId, videoUrl)
    if (!content) {
      return res.status(404).json({ error: 'CONTENT_NOT_PERSISTED', message: '该内容还没有入库摘要' })
    }

    const frames: AnalyzeFrameRef[] = []
    if (body.imageUrl) {
      frames.push({
        frameId: body.imageId || `img_${hashUrl(body.imageUrl)}`,
        idx: null,
        time: null,
        setId: null,
        url: body.imageUrl,
      })
    } else {
      const artifact = await loadKeyframeArtifact(auth.supabase, content.id)
      const payload = artifact?.payload as unknown as KeyframeSetPayload | undefined
      if (!payload) {
        return res.status(404).json({ error: 'KEYFRAMES_NOT_GENERATED', message: '请先生成关键帧' })
      }
      const requested = body.frameId ?? null
      for (const frame of payload.frames) {
        if (requested && frame.id !== requested) {
          continue
        }
        frames.push({ frameId: frame.id, idx: frame.idx, time: frame.time, setId: payload.setId, file: frame.file })
      }
      // 音频插图（mode=audio-illustrations）按 frameId 选择
      if (requested && !frames.length) {
        const illustration = payload.illustrations.find((item) => item.id === requested)
        if (illustration) {
          frames.push({ frameId: illustration.id, idx: null, time: null, setId: null, url: illustration.url })
        }
      }
      if (!frames.length) {
        return res.status(404).json({ error: 'frame_not_found', message: `未找到帧: ${requested}` })
      }
    }

    const batch = await analyzeFrameBatch({
      supabase: auth.supabase,
      userId: auth.userId,
      content,
      frames,
      force: body.force === true,
    })
    const analyses = await loadFrameAnalyses(auth.supabase, content.id, body.imageUrl ? null : frames[0]?.setId ?? null)
    return res.status(200).json({
      results: batch.results,
      okCount: batch.okCount,
      cachedCount: batch.cachedCount,
      errorCount: batch.errorCount,
      analyses: dedupeByFrameId(analyses),
    })
  } catch (error) {
    console.error('[vision] frames analyze failed:', error)
    const status = error instanceof SourceError ? sourceErrorCodeToHttpStatus(error.code) : 500
    return res.status(status).json({
      error: 'vision_error',
      message: error instanceof Error ? error.message : '帧分析失败',
    })
  }
}

function hashUrl(url: string): string {
  // 非 crypto 场景的短标识：仅用于无 imageId 时的稳定兜底 ID
  let hash = 0
  for (let i = 0; i < url.length; i += 1) {
    hash = (hash * 31 + url.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function dedupeByFrameId(analyses: FrameAnalysisPayload[]): FrameAnalysisPayload[] {
  const latest = new Map<string, FrameAnalysisPayload>()
  for (const analysis of analyses) {
    if (!latest.has(analysis.frameId)) {
      latest.set(analysis.frameId, analysis)
    }
  }
  return Array.from(latest.values())
}
