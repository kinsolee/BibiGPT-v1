import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChapterRow, ContentRow, HighlightRow } from '~/lib/history/types'
import { resolveContentBySource } from './generate'
import { parseVideoSourceUrl } from '~/lib/sources/registry'
import type {
  ArtifactBundle,
  ArtifactBundleResponse,
  ArtifactChapterItem,
  ArtifactChapterSource,
  ArtifactHighlightItem,
  ArtifactKeywordItem,
  ArtifactOutlineItem,
  ArtifactTranscriptSegment,
} from './types'

type ArtifactRecord = {
  id: string
  kind: string
  version: number
  payload: Record<string, unknown>
  created_at: string
}

function pickLatestByKind(records: ArtifactRecord[]): Record<string, ArtifactRecord> {
  const byKind: Record<string, ArtifactRecord> = {}
  for (const record of records) {
    // 查询按 version desc 排序，首个即为该 kind 的最新版本
    if (!byKind[record.kind]) {
      byKind[record.kind] = record
    }
  }
  return byKind
}

function coerceChapterItems(payload: unknown): ArtifactChapterItem[] {
  const items = (payload as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) {
    return []
  }
  return items
    .map((item, position) => {
      const chapter = item as Partial<ArtifactChapterItem>
      return {
        idx: typeof chapter.idx === 'number' ? chapter.idx : position,
        title: typeof chapter.title === 'string' ? chapter.title : '',
        start: typeof chapter.start === 'number' ? chapter.start : null,
        end: typeof chapter.end === 'number' ? chapter.end : null,
        summary: typeof chapter.summary === 'string' ? chapter.summary : null,
        source:
          chapter.source === 'platform'
            ? ('platform' as const)
            : chapter.source === 'generated'
            ? ('generated' as const)
            : null,
        segmentIds: Array.isArray(chapter.segmentIds) ? chapter.segmentIds.filter((id) => typeof id === 'number') : [],
      }
    })
    .filter((chapter) => Boolean(chapter.title))
}

function coerceHighlightItems(payload: unknown): ArtifactHighlightItem[] {
  const items = (payload as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) {
    return []
  }
  return items
    .map((item, position) => {
      const highlight = item as Partial<ArtifactHighlightItem>
      return {
        idx: typeof highlight.idx === 'number' ? highlight.idx : position,
        text: typeof highlight.text === 'string' ? highlight.text : '',
        start: typeof highlight.start === 'number' ? highlight.start : null,
        end: typeof highlight.end === 'number' ? highlight.end : null,
        note: typeof highlight.note === 'string' ? highlight.note : null,
        segmentIds: Array.isArray(highlight.segmentIds)
          ? highlight.segmentIds.filter((id) => typeof id === 'number')
          : [],
      }
    })
    .filter((highlight) => Boolean(highlight.text))
}

function coerceKeywordItems(payload: unknown): ArtifactKeywordItem[] {
  const items = (payload as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) {
    return []
  }
  return items
    .map((item) => (item as Partial<ArtifactKeywordItem>).term)
    .filter((term): term is string => typeof term === 'string' && Boolean(term))
    .map((term) => ({ term, segmentIds: [] }))
}

function coerceOutlineItems(payload: unknown): ArtifactOutlineItem[] {
  const items = (payload as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) {
    return []
  }
  return items
    .map((item) => {
      const outline = item as Partial<ArtifactOutlineItem>
      return {
        level: outline.level === 2 ? 2 : 1,
        title: typeof outline.title === 'string' ? outline.title : '',
        start: typeof outline.start === 'number' ? outline.start : null,
        end: typeof outline.end === 'number' ? outline.end : null,
        segmentIds: Array.isArray(outline.segmentIds) ? outline.segmentIds.filter((id) => typeof id === 'number') : [],
      }
    })
    .filter((item) => Boolean(item.title))
}

/** 无 artifacts 记录时的兜底：读 chapters/highlights 关系表镜像（如其它路径写入的数据） */
function chaptersFromRows(rows: ChapterRow[]): ArtifactChapterItem[] {
  return rows.map((row, position) => ({
    idx: row.idx ?? position,
    title: row.title ?? '',
    start: row.start,
    end: row.end,
    summary: row.summary,
    source: null,
    segmentIds: [],
  }))
}

function highlightsFromRows(rows: HighlightRow[]): ArtifactHighlightItem[] {
  return rows.map((row, position) => ({
    idx: row.idx ?? position,
    text: row.text ?? '',
    start: row.start,
    end: row.end,
    note: row.note,
    segmentIds: [],
  }))
}

export type LoadBundleParams = {
  supabase: SupabaseClient
  userId: string
  videoUrl?: string | null
  pageNumber?: string | null
  contentId?: string | null
}

/** 读取已落库的 artifacts bundle（不触发生成）；无内容时 found: false */
export async function loadArtifactBundle(params: LoadBundleParams): Promise<ArtifactBundleResponse> {
  const { supabase, userId } = params
  let content: ContentRow | null = null

  if (params.contentId) {
    const { data, error } = await supabase
      .from('contents')
      .select('*')
      .eq('id', params.contentId)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) {
      throw error
    }
    content = (data as ContentRow | null) ?? null
  } else if (params.videoUrl) {
    const parsed = parseVideoSourceUrl(params.videoUrl)
    if (parsed) {
      content = await resolveContentBySource(
        supabase,
        userId,
        parsed.adapter.id,
        parsed.videoId,
        params.pageNumber ?? null,
      )
    }
  }
  if (!content) {
    return { found: false }
  }

  const artifactsResult = await supabase
    .from('artifacts')
    .select('id, kind, version, payload, created_at')
    .eq('content_id', content.id)
    .order('version', { ascending: false })
    .order('created_at', { ascending: false })
  if (artifactsResult.error) {
    throw artifactsResult.error
  }
  const byKind = pickLatestByKind((artifactsResult.data ?? []) as ArtifactRecord[])

  let chapters = byKind.chapters ? coerceChapterItems(byKind.chapters.payload) : []
  let highlights = byKind.highlights ? coerceHighlightItems(byKind.highlights.payload) : []
  let chapterSource: ArtifactChapterSource | null = byKind.chapters
    ? (byKind.chapters.payload as { source?: unknown } | null)?.source === 'platform'
      ? 'platform'
      : 'generated'
    : null

  if (!chapters.length || !highlights.length) {
    const [chaptersResult, highlightsResult] = await Promise.all([
      supabase.from('chapters').select('*').eq('content_id', content.id).order('idx', { ascending: true }),
      supabase.from('highlights').select('*').eq('content_id', content.id).order('idx', { ascending: true }),
    ])
    if (chaptersResult.error) {
      throw chaptersResult.error
    }
    if (highlightsResult.error) {
      throw highlightsResult.error
    }
    if (!chapters.length) {
      chapters = chaptersFromRows((chaptersResult.data ?? []) as ChapterRow[])
    }
    if (!highlights.length) {
      highlights = highlightsFromRows((highlightsResult.data ?? []) as HighlightRow[])
    }
  }

  const hasGeneratedArtifacts = Boolean(byKind.chapters || byKind.highlights || byKind.keywords || byKind.outline)
  const generatedAt =
    byKind.chapters?.created_at ??
    byKind.highlights?.created_at ??
    byKind.keywords?.created_at ??
    byKind.outline?.created_at ??
    null

  // transcript 与 history 详情同口径：最新 summary 的 transcript；无 transcript 时给出缺失原因
  const latestSummary = await supabase
    .from('summaries')
    .select('id, transcript_id')
    .eq('content_id', content.id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestSummary.error) {
    throw latestSummary.error
  }
  const summary = latestSummary.data as { id: string; transcript_id: string | null } | null

  let transcript: ArtifactBundle['transcript'] = null
  if (summary?.transcript_id) {
    const transcriptResult = await supabase
      .from('transcripts')
      .select('id, lang, full_text')
      .eq('id', summary.transcript_id)
      .maybeSingle()
    if (transcriptResult.error) {
      throw transcriptResult.error
    }
    const transcriptRow = transcriptResult.data as { id: string; lang: string | null; full_text: string | null } | null
    if (transcriptRow) {
      const segmentsResult = await supabase
        .from('transcript_segments')
        .select('idx, start, end, text, speaker')
        .eq('transcript_id', transcriptRow.id)
        .order('idx', { ascending: true })
      if (segmentsResult.error) {
        throw segmentsResult.error
      }
      const segments = (
        (segmentsResult.data ?? []) as Array<
          Pick<ArtifactTranscriptSegment, 'idx' | 'start' | 'end' | 'text' | 'speaker'>
        >
      ).map((segment) => ({ ...segment }))
      transcript = { id: transcriptRow.id, lang: transcriptRow.lang, fullText: transcriptRow.full_text, segments }
    }
  }

  const transcriptMissingReason = transcript?.segments.length
    ? null
    : transcript?.fullText
    ? '该视频没有字幕，摘要基于视频简介生成，无法定位章节时间点'
    : summary
    ? '该视频没有可用字幕'
    : '尚未生成摘要，无法提取字幕'

  return {
    found: true,
    contentId: content.id,
    summaryId: summary?.id ?? null,
    chapterSource: hasGeneratedArtifacts || chapters.length ? chapterSource : null,
    generatedAt,
    chapters,
    highlights,
    keywords: byKind.keywords ? coerceKeywordItems(byKind.keywords.payload) : [],
    outline: byKind.outline ? coerceOutlineItems(byKind.outline.payload) : [],
    transcript,
    transcriptMissingReason,
  }
}
