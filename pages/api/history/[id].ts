import type { NextApiRequest, NextApiResponse } from 'next'
import type { SupabaseClient } from '@supabase/supabase-js'
import { toListItem, toSummaryDTO } from '~/lib/history/dto'
import { requireUserId } from '~/lib/history/server'
import {
  ArtifactRow,
  ChapterRow,
  ContentRow,
  HighlightRow,
  HistoryDetailDTO,
  SummaryRow,
  TranscriptRow,
  TranscriptSegmentRow,
} from '~/lib/history/types'

async function loadDetail(supabase: SupabaseClient, id: string): Promise<HistoryDetailDTO | null> {
  const content = await supabase.from('contents').select('*').eq('id', id).maybeSingle()
  if (content.error) {
    throw content.error
  }
  if (!content.data) {
    return null
  }
  const contentRow = content.data as ContentRow

  const summaries = await supabase
    .from('summaries')
    .select('*')
    .eq('content_id', id)
    .order('version', { ascending: false })
  if (summaries.error) {
    throw summaries.error
  }
  const summaryRows = (summaries.data ?? []) as SummaryRow[]

  const latestTranscript = await supabase
    .from('transcripts')
    .select('*')
    .eq('content_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
  if (latestTranscript.error) {
    throw latestTranscript.error
  }
  const transcriptRow = ((latestTranscript.data ?? [])[0] ?? null) as TranscriptRow | null
  let transcript: HistoryDetailDTO['transcript'] = null
  if (transcriptRow) {
    const segments = await supabase
      .from('transcript_segments')
      .select('id, transcript_id, idx, start, end, text, lang, speaker, source_ref')
      .eq('transcript_id', transcriptRow.id)
      .order('idx', { ascending: true })
    if (segments.error) {
      throw segments.error
    }
    const segmentRows = (segments.data ?? []) as TranscriptSegmentRow[]
    transcript = {
      id: transcriptRow.id,
      lang: transcriptRow.lang,
      fullText: transcriptRow.full_text,
      segmentCount: transcriptRow.segment_count,
      createdAt: transcriptRow.created_at,
      segments: segmentRows.map((segment) => ({
        idx: segment.idx,
        start: segment.start,
        end: segment.end,
        text: segment.text,
        speaker: segment.speaker,
      })),
    }
  }

  const chapters = await supabase.from('chapters').select('*').eq('content_id', id).order('idx', { ascending: true })
  if (chapters.error) {
    throw chapters.error
  }
  const highlights = await supabase
    .from('highlights')
    .select('*')
    .eq('content_id', id)
    .order('idx', { ascending: true })
  if (highlights.error) {
    throw highlights.error
  }
  const artifacts = await supabase
    .from('artifacts')
    .select('*')
    .eq('content_id', id)
    .order('created_at', { ascending: false })
  if (artifacts.error) {
    throw artifacts.error
  }

  return {
    content: toListItem(contentRow, summaryRows[0] ?? null),
    summaries: summaryRows.map(toSummaryDTO),
    transcript,
    chapters: ((chapters.data ?? []) as ChapterRow[]).map((chapter) => ({
      idx: chapter.idx,
      start: chapter.start,
      end: chapter.end,
      title: chapter.title,
      summary: chapter.summary,
    })),
    highlights: ((highlights.data ?? []) as HighlightRow[]).map((highlight) => ({
      idx: highlight.idx,
      start: highlight.start,
      end: highlight.end,
      text: highlight.text,
      note: highlight.note,
    })),
    artifacts: ((artifacts.data ?? []) as ArtifactRow[]).map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      version: artifact.version,
      payload: artifact.payload,
      createdAt: artifact.created_at,
    })),
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }

  const { id } = req.query
  if (typeof id !== 'string' || !id) {
    return res.status(400).json({ error: 'bad_request', message: 'missing id' })
  }

  try {
    if (req.method === 'GET') {
      const detail = await loadDetail(auth.supabase, id)
      if (!detail) {
        return res.status(404).json({ error: 'not_found' })
      }
      return res.status(200).json(detail)
    }

    if (req.method === 'DELETE') {
      // 级联删除 summaries/transcripts/segments/artifacts/chapters/highlights 等
      const deleted = await auth.supabase.from('contents').delete().eq('id', id).select('id')
      if (deleted.error) {
        throw deleted.error
      }
      if (!deleted.data?.length) {
        return res.status(404).json({ error: 'not_found' })
      }
      return res.status(200).json({ deleted: true, id })
    }

    res.setHeader('Allow', 'GET, DELETE')
    return res.status(405).json({ error: 'method_not_allowed' })
  } catch (error: any) {
    console.error('history detail failed:', error)
    return res.status(500).json({ error: 'internal_error', message: error?.message ?? 'Internal Server Error' })
  }
}
