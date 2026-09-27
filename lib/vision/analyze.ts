// 帧分析编排（server-only）：逐帧隔离错误，同 (frameHash, model) 缓存命中
// 不重复调 VLM；失败帧标记 error 可重试，绝不因单帧失败中断整批。
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContentRow } from '~/lib/history/types'

import { getVisionModel } from './config'
import { loadFrameImage } from './generate'
import { computeFrameAnalysisInputHash, findCachedFrameAnalysis, persistFrameAnalysis } from './persist'
import type { FrameAnalysisOutcome, FrameAnalysisPayload } from './types'
import { analyzeFrameImage } from './vlm'

export interface AnalyzeFrameRef {
  frameId: string
  idx: number | null
  time: number | null
  setId: string | null
  file?: string
  url?: string
}

/** 测试注入点：生产默认真实 VLM 调用 */
export type VlmAnalyzeFn = typeof analyzeFrameImage

export async function analyzeFrameRef(params: {
  supabase: SupabaseClient
  userId: string
  content: ContentRow
  frame: AnalyzeFrameRef
  force?: boolean
  model?: string
  baseUrl?: string
  apiKey?: string
  vlmFn?: VlmAnalyzeFn
}): Promise<FrameAnalysisOutcome> {
  const { supabase, userId, content, frame } = params
  const model = params.model?.trim() || getVisionModel()
  const vlmFn = params.vlmFn ?? analyzeFrameImage
  try {
    const image = await loadFrameImage({ setId: frame.setId, file: frame.file, url: frame.url })

    if (!params.force) {
      const cached = await findCachedFrameAnalysis(supabase, content.id, image.frameHash, model)
      if (cached) {
        return { frameId: frame.frameId, status: 'cached', analysis: cached }
      }
    }

    const result = await vlmFn(image, { model, baseUrl: params.baseUrl, apiKey: params.apiKey })
    const payload: FrameAnalysisPayload = {
      setId: frame.setId,
      frameId: frame.frameId,
      idx: frame.idx,
      time: frame.time,
      ocr: result.ocr,
      description: result.description,
      tags: result.tags,
      model,
      generatedAt: new Date().toISOString(),
    }
    const inputHash = await computeFrameAnalysisInputHash({ frameHash: image.frameHash, model })
    await persistFrameAnalysis({
      supabase,
      userId,
      contentId: content.id,
      summaryId: null,
      payload,
      refs: {
        inputHash,
        setId: frame.setId,
        frameId: frame.frameId,
        frameHash: image.frameHash,
        model,
      },
      force: params.force,
    })
    return { frameId: frame.frameId, status: 'ok', analysis: payload }
  } catch (error) {
    return {
      frameId: frame.frameId,
      status: 'error',
      error: error instanceof Error ? error.message : '帧分析失败',
    }
  }
}

export async function analyzeFrameBatch(params: {
  supabase: SupabaseClient
  userId: string
  content: ContentRow
  frames: AnalyzeFrameRef[]
  force?: boolean
  model?: string
  baseUrl?: string
  apiKey?: string
  vlmFn?: VlmAnalyzeFn
}): Promise<{ results: FrameAnalysisOutcome[]; okCount: number; cachedCount: number; errorCount: number }> {
  const results: FrameAnalysisOutcome[] = []
  for (const frame of params.frames) {
    results.push(await analyzeFrameRef({ ...params, frame }))
  }
  const okCount = results.filter((result) => result.status === 'ok').length
  const cachedCount = results.filter((result) => result.status === 'cached').length
  const errorCount = results.filter((result) => result.status === 'error').length
  console.debug(
    `[vision] analyze: content=${params.content.id} total=${results.length} ok=${okCount} cached=${cachedCount} error=${errorCount}`,
  )
  return { results, okCount, cachedCount, errorCount }
}
