import { loadArtifactBundle } from '~/lib/artifacts/bundle'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TranscriptSegment } from '~/lib/sources/types'
import type { V1ContentReader } from './handlers/contents'

interface SummaryRow {
  id: string
  transcript_id: string | null
  content_text: string | null
}

interface TranscriptRow {
  id: string
  lang: string | null
}

interface SegmentRow {
  idx: number
  start: number | null
  end: number | null
  text: string
  lang: string | null
  speaker: string | null
  source_ref: string | null
}

function toTranscriptSegment(row: SegmentRow): TranscriptSegment {
  const start = row.start ?? 0
  return {
    start,
    end: row.end ?? start,
    text: row.text,
    ...(row.lang ? { lang: row.lang } : {}),
    ...(row.speaker ? { speaker: row.speaker } : {}),
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
  }
}

/**
 * 默认 contents 读取：transcript 严格跟随最新 summary 的 transcript_id
 * （与 pages/api/history/[id].ts 同口径），无 summary/无 transcript 时返回空。
 */
export function createSupabaseContentReader(supabase: SupabaseClient): V1ContentReader {
  return {
    async getContent(contentId, userId) {
      const { data, error } = await supabase
        .from('contents')
        .select('id, title, source_url')
        .eq('id', contentId)
        .eq('user_id', userId)
        .maybeSingle()
      if (error) {
        throw error
      }
      const row = data as { id: string; title: string | null; source_url: string } | null
      return row ? { id: row.id, title: row.title, sourceUrl: row.source_url } : null
    },
    async getLatestSummaryText(contentId) {
      const { data, error } = await supabase
        .from('summaries')
        .select('id, transcript_id, content_text')
        .eq('content_id', contentId)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (error) {
        throw error
      }
      return ((data ?? null) as SummaryRow | null)?.content_text ?? null
    },
    async getTranscript(contentId) {
      const summary = await supabase
        .from('summaries')
        .select('id, transcript_id, content_text')
        .eq('content_id', contentId)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (summary.error) {
        throw summary.error
      }
      const transcriptId = ((summary.data ?? null) as SummaryRow | null)?.transcript_id
      if (!transcriptId) {
        return { lang: null, segments: [] }
      }
      const transcript = await supabase.from('transcripts').select('id, lang').eq('id', transcriptId).maybeSingle()
      if (transcript.error) {
        throw transcript.error
      }
      const segments = await supabase
        .from('transcript_segments')
        .select('idx, start, end, text, lang, speaker, source_ref')
        .eq('transcript_id', transcriptId)
        .order('idx', { ascending: true })
      if (segments.error) {
        throw segments.error
      }
      const rows = (segments.data ?? []) as SegmentRow[]
      return {
        lang: ((transcript.data ?? null) as TranscriptRow | null)?.lang ?? null,
        segments: rows.map(toTranscriptSegment),
      }
    },
    async getArtifact(contentId, userId) {
      const response = await loadArtifactBundle({ supabase, userId, contentId })
      return response.found ? response : null
    },
  }
}
