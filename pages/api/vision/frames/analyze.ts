import type { NextApiRequest, NextApiResponse } from 'next'
import type { SupabaseClient } from '@supabase/supabase-js'

import { requireUserId } from '~/lib/history/server'
import { analyzeFrameBatch } from '~/lib/vision/analyze'
import { illustrationIdFor } from '~/lib/vision/generate'
import { loadFrameAnalyses, loadKeyframeArtifact, loadImageNoteArtifact } from '~/lib/vision/persist'
import { resolveVisionContent } from '~/lib/vision/media'
import { sourceErrorCodeToHttpStatus, SourceError } from '~/lib/sources/types'
import type { AnalyzeFrameRef } from '~/lib/vision/analyze'
import type { FrameAnalysisPayload, KeyframeSetPayload } from '~/lib/vision/types'

export const config = { maxDuration: 300 }

/**
 * POST /api/vision/frames/analyze
 * body: { videoUrl, frameId?, imageId?, force? }
 * - frameId：分析已落库关键帧集合里的指定帧（含音频插图 illu_*）；省略则分析全部帧
 * - imageId：分析图文笔记缓存图片（id 由服务端 sha1(url) 派生）
 * P1-1：不接受客户端直传 imageUrl；服务端 fetch 的 URL 只能来自已落库
 * artifacts（keyframes payload / image_note_images 缓存），且过公网守卫。
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
    let analysesSetId: string | null = null
    if (body.imageId) {
      // imageId 只接受已落库图片：先查 keyframes 插图，再查图文笔记缓存
      const imageUrl = await resolvePersistedImageUrl(auth.supabase, auth.userId, content.id, body.imageId)
      if (!imageUrl) {
        return res.status(404).json({ error: 'image_not_found', message: `未找到已保存的图片: ${body.imageId}` })
      }
      frames.push({ frameId: body.imageId, idx: null, time: null, setId: null, url: imageUrl })
    } else {
      const artifact = await loadKeyframeArtifact(auth.supabase, content.id)
      const payload = artifact?.payload as unknown as KeyframeSetPayload | undefined
      if (!payload) {
        return res.status(404).json({ error: 'KEYFRAMES_NOT_GENERATED', message: '请先生成关键帧' })
      }
      analysesSetId = payload.setId
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
    const analyses = await loadFrameAnalyses(auth.supabase, content.id, analysesSetId)
    return res.status(200).json({
      results: batch.results,
      okCount: batch.okCount,
      cachedCount: batch.cachedCount,
      errorCount: batch.errorCount,
      skippedCount: batch.skippedCount,
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

/** imageId → 已落库图片 URL：keyframes 插图优先，其次 image_note_images 缓存 */
async function resolvePersistedImageUrl(
  supabase: SupabaseClient,
  userId: string,
  contentId: string,
  imageId: string,
): Promise<string | null> {
  const keyframes = await loadKeyframeArtifact(supabase, contentId)
  const payload = keyframes?.payload as unknown as KeyframeSetPayload | undefined
  const fromKeyframes = payload?.illustrations.find((item) => item.id === imageId)
  if (fromKeyframes) {
    return fromKeyframes.url
  }
  const note = await loadImageNoteArtifact(supabase, contentId)
  const images = (note?.payload as { images?: Array<{ url: string }> } | undefined)?.images ?? []
  const matched = images.find((image) => illustrationIdFor(image.url) === imageId)
  return matched?.url ?? null
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
