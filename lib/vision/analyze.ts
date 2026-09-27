// 帧分析编排（server-only）：逐帧隔离错误，同 (frameHash, model) 缓存命中
// 不重复调 VLM；失败帧标记 error 可重试，绝不因单帧失败中断整批。
// 批量分析两阶段执行：先串行做缓存预检（快），未命中帧再以有界并发跑 VLM，
// 并受批次 deadline 约束（route maxDuration 内必返回）；超时未启动的帧标记
// skipped，已完成帧已逐帧落库，续跑只补剩余。
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

interface BatchOptions {
  supabase: SupabaseClient
  userId: string
  content: ContentRow
  force?: boolean
  model?: string
  baseUrl?: string
  apiKey?: string
  vlmFn?: VlmAnalyzeFn
}

function resolveModel(params: { model?: string }): string {
  return params.model?.trim() || getVisionModel()
}

async function runVlmAndPersist(
  params: BatchOptions,
  model: string,
  frame: AnalyzeFrameRef,
  image: { base64: string; mime: string; frameHash: string },
): Promise<FrameAnalysisOutcome> {
  const vlmFn = params.vlmFn ?? analyzeFrameImage
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
    supabase: params.supabase,
    userId: params.userId,
    contentId: params.content.id,
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
}

/** 单帧完整流程：读图 → 查缓存 → VLM → 落库。任一步失败只影响该帧。 */
export async function analyzeFrameRef(
  params: BatchOptions & { frame: AnalyzeFrameRef },
): Promise<FrameAnalysisOutcome> {
  const model = resolveModel(params)
  const { frame } = params
  try {
    const image = await loadFrameImage({ setId: frame.setId, file: frame.file, url: frame.url })
    if (!params.force) {
      const cached = await findCachedFrameAnalysis(params.supabase, params.content.id, image.frameHash, model)
      if (cached) {
        return { frameId: frame.frameId, status: 'cached', analysis: cached }
      }
    }
    return await runVlmAndPersist(params, model, frame, image)
  } catch (error) {
    return {
      frameId: frame.frameId,
      status: 'error',
      error: error instanceof Error ? error.message : '帧分析失败',
    }
  }
}

function toErrorOutcome(frame: AnalyzeFrameRef, error: unknown): FrameAnalysisOutcome {
  return {
    frameId: frame.frameId,
    status: 'error',
    error: error instanceof Error ? error.message : '帧分析失败',
  }
}

export interface BatchAnalysisResult {
  results: FrameAnalysisOutcome[]
  okCount: number
  cachedCount: number
  errorCount: number
  skippedCount: number
}

/**
 * 批量分析：
 * 1. 串行预检阶段——逐帧读图 + 缓存查询（无 VLM 调用，快），收集未命中帧；
 * 2. 并发阶段——有界并发跑 VLM，每个任务启动前检查批次 deadline，
 *    超时后剩余帧一律标 skipped（可再次调用续跑，已完成帧走缓存）。
 */
export async function analyzeFrameBatch(
  params: BatchOptions & { frames: AnalyzeFrameRef[] },
): Promise<BatchAnalysisResult> {
  const model = resolveModel(params)
  const results: FrameAnalysisOutcome[] = new Array(params.frames.length)
  interface Miss {
    index: number
    frame: AnalyzeFrameRef
    image: { base64: string; mime: string; frameHash: string }
  }
  const misses: Miss[] = []

  for (let index = 0; index < params.frames.length; index += 1) {
    const frame = params.frames[index]
    try {
      const image = await loadFrameImage({ setId: frame.setId, file: frame.file, url: frame.url })
      if (!params.force) {
        const cached = await findCachedFrameAnalysis(params.supabase, params.content.id, image.frameHash, model)
        if (cached) {
          results[index] = { frameId: frame.frameId, status: 'cached', analysis: cached }
          continue
        }
      }
      misses.push({ index, frame, image })
    } catch (error) {
      results[index] = toErrorOutcome(frame, error)
    }
  }

  const { getBatchDeadlineMs, getAnalyzeConcurrency } = await import('./config')
  const deadline = Date.now() + getBatchDeadlineMs()
  const concurrency = Math.max(1, Math.min(getAnalyzeConcurrency(), misses.length))
  let cursor = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const current = cursor
      cursor += 1
      if (current >= misses.length) {
        return
      }
      const miss = misses[current]
      if (Date.now() >= deadline) {
        results[miss.index] = {
          frameId: miss.frame.frameId,
          status: 'skipped',
          error: '已达单次请求分析时限，已完成的帧不受影响；再次点击「分析全部画面」可续跑剩余帧',
        }
        continue
      }
      try {
        results[miss.index] = await runVlmAndPersist(params, model, miss.frame, miss.image)
      } catch (error) {
        results[miss.index] = toErrorOutcome(miss.frame, error)
      }
    }
  })
  await Promise.all(workers)

  const okCount = results.filter((result) => result?.status === 'ok').length
  const cachedCount = results.filter((result) => result?.status === 'cached').length
  const errorCount = results.filter((result) => result?.status === 'error').length
  const skippedCount = results.filter((result) => result?.status === 'skipped').length
  console.debug(
    `[vision] analyze: content=${params.content.id} total=${results.length} ok=${okCount} cached=${cachedCount} error=${errorCount} skipped=${skippedCount}`,
  )
  return { results, okCount, cachedCount, errorCount, skippedCount }
}
