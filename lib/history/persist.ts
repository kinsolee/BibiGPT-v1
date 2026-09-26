import type { SupabaseClient } from '@supabase/supabase-js'
import { sha256Hex, stableStringify } from './hash'
import { MediaDocumentMetadata, TranscriptSegment } from './types'

export const PROMPT_VERSION = 'v1'

export async function hashTranscriptInput(
  meta: Pick<MediaDocumentMetadata, 'service' | 'sourceRef' | 'sourcePage'>,
  segments: TranscriptSegment[],
  fullText?: string | null,
) {
  const payload = stableStringify({
    service: meta.service,
    sourceRef: meta.sourceRef,
    sourcePage: meta.sourcePage,
    segments: segments.map((s) => [s.start, s.end, s.text]),
    fullText: fullText ?? null,
  })
  return sha256Hex(payload)
}

export async function hashSummaryInput(transcriptHash: string, config: Record<string, unknown>, model: string | null) {
  return sha256Hex(stableStringify({ transcriptHash, config, model: model ?? null, promptVersion: PROMPT_VERSION }))
}

export type PersistSummarizedContentParams = {
  supabase: SupabaseClient
  userId: string
  media: MediaDocumentMetadata
  sourceMetadata?: Record<string, unknown>
  segments: TranscriptSegment[]
  transcriptFullText?: string | null
  transcriptLang?: string | null
  config: Record<string, unknown>
  model: string | null
  summaryText: string
}

export type PersistResult = {
  contentId: string
  summaryId: string
  version: number
  reused: boolean
}

async function findContentId(supabase: SupabaseClient, userId: string, media: MediaDocumentMetadata) {
  let match = supabase
    .from('contents')
    .select('id')
    .eq('user_id', userId)
    .eq('service', media.service)
    .eq('source_ref', media.sourceRef)
  // PostgREST 的 is 过滤仅用于 NULL；非空 source_page 必须等值匹配
  match = media.sourcePage === null ? match.is('source_page', null) : match.eq('source_page', media.sourcePage)
  return match.maybeSingle()
}

async function upsertContent(
  supabase: SupabaseClient,
  userId: string,
  media: MediaDocumentMetadata,
  sourceMetadata: Record<string, unknown>,
): Promise<string> {
  const existing = await findContentId(supabase, userId, media)
  if (existing.error) {
    throw existing.error
  }
  if (existing.data) {
    const updated = await supabase
      .from('contents')
      .update({
        source_url: media.sourceUrl,
        title: media.title ?? null,
        duration: media.duration,
        language: media.language,
        source_metadata: sourceMetadata,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.data.id)
      .select('id')
      .single()
    if (updated.error) {
      throw updated.error
    }
    return updated.data.id
  }

  const inserted = await supabase
    .from('contents')
    .insert({
      user_id: userId,
      source_url: media.sourceUrl,
      service: media.service,
      source_ref: media.sourceRef,
      source_page: media.sourcePage,
      title: media.title ?? null,
      duration: media.duration,
      language: media.language,
      source_metadata: sourceMetadata,
      last_summarized_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (inserted.error) {
    // 并发下唯一约束冲突时回退为读取已存在行
    if (inserted.error.code === '23505') {
      const again = await findContentId(supabase, userId, media)
      if (again.error || !again.data) {
        throw again.error ?? new Error('content upsert conflict but row not found')
      }
      return again.data.id
    }
    throw inserted.error
  }
  return inserted.data.id
}

async function upsertTranscript(
  supabase: SupabaseClient,
  userId: string,
  contentId: string,
  inputHash: string,
  media: MediaDocumentMetadata,
  segments: TranscriptSegment[],
  fullText: string | null,
  lang: string | null,
): Promise<string> {
  const existing = await supabase
    .from('transcripts')
    .select('id')
    .eq('content_id', contentId)
    .eq('input_hash', inputHash)
    .maybeSingle()
  if (existing.error) {
    throw existing.error
  }
  if (existing.data) {
    return existing.data.id
  }

  const inserted = await supabase
    .from('transcripts')
    .insert({
      user_id: userId,
      content_id: contentId,
      lang,
      source: media.service,
      source_ref: media.sourceRef,
      full_text: fullText,
      segment_count: segments.length,
      input_hash: inputHash,
    })
    .select('id')
    .single()
  if (inserted.error) {
    if (inserted.error.code === '23505') {
      const again = await supabase
        .from('transcripts')
        .select('id')
        .eq('content_id', contentId)
        .eq('input_hash', inputHash)
        .single()
      if (again.error) {
        throw again.error
      }
      return again.data.id
    }
    throw inserted.error
  }

  const transcriptId = inserted.data.id
  const rows = segments.map((segment, idx) => ({
    user_id: userId,
    transcript_id: transcriptId,
    idx,
    start: segment.start,
    end: segment.end,
    text: segment.text,
    lang: segment.lang ?? null,
    speaker: segment.speaker ?? null,
    source_ref: segment.sourceRef ?? null,
  }))
  // 分批写入，避免单条 SQL 过大；任一批失败则删除 transcript 行（级联清除已写 segments），
  // 保证不留半截数据，重试可完整重建
  const CHUNK_SIZE = 500
  try {
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE)
      const { error } = await supabase.from('transcript_segments').insert(chunk)
      if (error) {
        throw error
      }
    }
  } catch (segmentError) {
    await supabase.from('transcripts').delete().eq('id', transcriptId)
    throw segmentError
  }
  return transcriptId
}

export async function persistSummarizedContent(params: PersistSummarizedContentParams): Promise<PersistResult> {
  const { supabase, userId, media, segments, config, model, summaryText } = params
  const sourceMetadata = {
    ...(params.sourceMetadata ?? {}),
    ...(media.sourcePage ? { pageNumber: media.sourcePage } : {}),
  }

  const contentId = await upsertContent(supabase, userId, media, sourceMetadata)

  const transcriptHash = await hashTranscriptInput(media, segments, params.transcriptFullText ?? null)
  const transcriptId = await upsertTranscript(
    supabase,
    userId,
    contentId,
    transcriptHash,
    media,
    segments,
    params.transcriptFullText ?? (segments.map((s) => s.text).join(' ') || null),
    params.transcriptLang ?? null,
  )

  const summaryHash = await hashSummaryInput(transcriptHash, config, model)

  // 唯一索引 (content_id, version) 兜底下，读-算-插的并发冲突以重读重试解决
  for (let attempt = 0; attempt < 3; attempt++) {
    const existingSummary = await supabase
      .from('summaries')
      .select('id, version')
      .eq('content_id', contentId)
      .eq('input_hash', summaryHash)
      .maybeSingle()
    if (existingSummary.error) {
      throw existingSummary.error
    }
    if (existingSummary.data) {
      return { contentId, summaryId: existingSummary.data.id, version: existingSummary.data.version, reused: true }
    }

    const maxVersion = await supabase
      .from('summaries')
      .select('version')
      .eq('content_id', contentId)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (maxVersion.error) {
      throw maxVersion.error
    }

    const insertedSummary = await supabase
      .from('summaries')
      .insert({
        user_id: userId,
        content_id: contentId,
        transcript_id: transcriptId,
        config,
        model: model ?? null,
        prompt_version: PROMPT_VERSION,
        status: 'completed',
        input_hash: summaryHash,
        version: (maxVersion.data?.version ?? 0) + 1,
        content_text: summaryText,
      })
      .select('id, version')
      .single()
    if (!insertedSummary.error) {
      await supabase
        .from('contents')
        .update({ last_summarized_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', contentId)

      return { contentId, summaryId: insertedSummary.data.id, version: insertedSummary.data.version, reused: false }
    }
    if (insertedSummary.error.code !== '23505') {
      throw insertedSummary.error
    }
    // 冲突来源二选一：(content_id, input_hash) 幂等命中——循环顶部的查询会命中并返回；
    // (content_id, version) 并发竞争——重读 max version 后重试
  }
  throw new Error('summary version allocation failed after retries')
}
