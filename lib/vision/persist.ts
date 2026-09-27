// vision artifacts 读写（server-only）：写入 KIN-41 artifacts 表（kind=
// keyframes / frame_analysis / image_note_images），幂等键 refs.inputHash
// contains 命中即复用；与 lib/artifacts/persist 同一模式，本模块自持实现。
import type { SupabaseClient } from '@supabase/supabase-js'

import { sha256Hex, stableStringify } from '~/lib/history/hash'
import type { ArtifactRow } from '~/lib/history/types'

import type {
  FrameAnalysisPayload,
  FrameAnalysisRefs,
  ImageNotePayload,
  ImageNoteRefs,
  KeyframeSetPayload,
  KeyframeSetRefs,
} from './types'

export const KEYFRAMES_KIND = 'keyframes'
export const FRAME_ANALYSIS_KIND = 'frame_analysis'
export const IMAGE_NOTE_KIND = 'image_note_images'
export const VISION_PROMPT_VERSION = 'vision-v1'

async function nextArtifactVersion(supabase: SupabaseClient, contentId: string, kind: string): Promise<number> {
  const latest = await supabase
    .from('artifacts')
    .select('version')
    .eq('content_id', contentId)
    .eq('kind', kind)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latest.error) {
    throw latest.error
  }
  return (latest.data?.version ?? 0) + 1
}

export async function computeKeyframesInputHash(input: {
  sourceRef: string
  threshold: number
  maxFrames: number
  minGapSeconds: number
  duration: number | null
}): Promise<string> {
  return sha256Hex(stableStringify({ promptVersion: VISION_PROMPT_VERSION, ...input }))
}

export async function computeFrameAnalysisInputHash(input: { frameHash: string; model: string }): Promise<string> {
  return sha256Hex(stableStringify({ promptVersion: VISION_PROMPT_VERSION, ...input }))
}

export async function computeImageNoteInputHash(input: { sourceRef: string; urls: string[] }): Promise<string> {
  return sha256Hex(stableStringify({ promptVersion: VISION_PROMPT_VERSION, ...input }))
}

type InsertArtifactArgs = {
  supabase: SupabaseClient
  userId: string
  contentId: string
  summaryId: string | null
  kind: string
  payload: Record<string, unknown>
  refs: Record<string, unknown>
  inputHash: string
  force?: boolean
}

/** inputHash 幂等写入；命中返回 reused:true。force 跳过幂等检查追加新版本。 */
async function insertArtifactIdempotent(args: InsertArtifactArgs): Promise<{ reused: boolean; version: number }> {
  const { supabase, userId, contentId, summaryId, kind, payload, refs, inputHash, force } = args
  if (!force) {
    const existing = await supabase
      .from('artifacts')
      .select('id, version')
      .eq('content_id', contentId)
      .eq('kind', kind)
      .contains('refs', { inputHash })
      .maybeSingle()
    if (existing.error) {
      throw existing.error
    }
    if (existing.data) {
      return { reused: true, version: existing.data.version }
    }
  }
  const version = await nextArtifactVersion(supabase, contentId, kind)
  const inserted = await supabase
    .from('artifacts')
    .insert({ user_id: userId, content_id: contentId, summary_id: summaryId, kind, version, payload, refs })
    .select('version')
    .single()
  if (inserted.error) {
    throw inserted.error
  }
  return { reused: false, version: inserted.data.version }
}

export async function persistKeyframeSet(params: {
  supabase: SupabaseClient
  userId: string
  contentId: string
  summaryId: string | null
  payload: KeyframeSetPayload
  refs: KeyframeSetRefs
  force?: boolean
}): Promise<{ reused: boolean; version: number }> {
  return insertArtifactIdempotent({
    supabase: params.supabase,
    userId: params.userId,
    contentId: params.contentId,
    summaryId: params.summaryId,
    kind: KEYFRAMES_KIND,
    payload: params.payload as unknown as Record<string, unknown>,
    refs: params.refs as unknown as Record<string, unknown>,
    inputHash: params.refs.inputHash,
    force: params.force,
  })
}

export async function persistFrameAnalysis(params: {
  supabase: SupabaseClient
  userId: string
  contentId: string
  summaryId: string | null
  payload: FrameAnalysisPayload
  refs: FrameAnalysisRefs
  force?: boolean
}): Promise<{ reused: boolean; version: number }> {
  return insertArtifactIdempotent({
    supabase: params.supabase,
    userId: params.userId,
    contentId: params.contentId,
    summaryId: params.summaryId,
    kind: FRAME_ANALYSIS_KIND,
    payload: params.payload as unknown as Record<string, unknown>,
    refs: params.refs as unknown as Record<string, unknown>,
    inputHash: params.refs.inputHash,
    force: params.force,
  })
}

export async function persistImageNoteCache(params: {
  supabase: SupabaseClient
  userId: string
  contentId: string
  payload: ImageNotePayload
  refs: ImageNoteRefs
}): Promise<{ reused: boolean; version: number }> {
  return insertArtifactIdempotent({
    supabase: params.supabase,
    userId: params.userId,
    contentId: params.contentId,
    summaryId: null,
    kind: IMAGE_NOTE_KIND,
    payload: params.payload as unknown as Record<string, unknown>,
    refs: params.refs as unknown as Record<string, unknown>,
    inputHash: params.refs.inputHash,
  })
}

async function loadLatestArtifact(
  supabase: SupabaseClient,
  contentId: string,
  kind: string,
): Promise<ArtifactRow | null> {
  const result = await supabase
    .from('artifacts')
    .select('*')
    .eq('content_id', contentId)
    .eq('kind', kind)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (result.error) {
    throw result.error
  }
  return (result.data as ArtifactRow | null) ?? null
}

export async function loadKeyframeArtifact(supabase: SupabaseClient, contentId: string): Promise<ArtifactRow | null> {
  return loadLatestArtifact(supabase, contentId, KEYFRAMES_KIND)
}

export async function loadImageNoteArtifact(supabase: SupabaseClient, contentId: string): Promise<ArtifactRow | null> {
  return loadLatestArtifact(supabase, contentId, IMAGE_NOTE_KIND)
}

export async function loadFrameAnalyses(
  supabase: SupabaseClient,
  contentId: string,
  setId: string | null,
): Promise<FrameAnalysisPayload[]> {
  let query = supabase
    .from('artifacts')
    .select('payload, version')
    .eq('content_id', contentId)
    .eq('kind', FRAME_ANALYSIS_KIND)
    .order('version', { ascending: false })
  if (setId !== null) {
    query = query.contains('refs', { setId })
  }
  const result = await query.limit(200)
  if (result.error) {
    throw result.error
  }
  const latestByFrame = new Map<string, FrameAnalysisPayload>()
  for (const row of (result.data ?? []) as Array<{ payload: unknown }>) {
    const payload = row.payload as FrameAnalysisPayload
    if (
      payload &&
      typeof payload === 'object' &&
      typeof payload.frameId === 'string' &&
      !latestByFrame.has(payload.frameId)
    ) {
      latestByFrame.set(payload.frameId, payload)
    }
  }
  return Array.from(latestByFrame.values())
}

/** 按 (frameHash, model) 查缓存：同内容同模型不重复调 VLM */
export async function findCachedFrameAnalysis(
  supabase: SupabaseClient,
  contentId: string,
  frameHash: string,
  model: string,
): Promise<FrameAnalysisPayload | null> {
  const result = await supabase
    .from('artifacts')
    .select('payload')
    .eq('content_id', contentId)
    .eq('kind', FRAME_ANALYSIS_KIND)
    .contains('refs', { frameHash, model })
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (result.error) {
    throw result.error
  }
  return (result.data?.payload as FrameAnalysisPayload | undefined) ?? null
}
