import type { SupabaseClient } from '@supabase/supabase-js'
import { selectApiKeyAndActivatedLicenseKey } from '~/lib/openai/selectApiKeyAndActivatedLicenseKey'
import { parseVideoSourceUrl } from '~/lib/sources/registry'
import type { ContentRow, SummaryRow, TranscriptRow, TranscriptSegmentRow } from '~/lib/history/types'
import { SourceError } from '~/lib/sources/types'
import type { MediaDocument, SourceChapter, TranscriptSegment } from '~/lib/sources/types'
import { generateStructuredArtifacts } from './model'
import type { RawGeneratedArtifacts } from './model'
import { persistArtifacts } from './persist'
import { SegmentIndex } from './segments'
import type {
  ArtifactBundle,
  ArtifactChapterItem,
  ArtifactChapterSource,
  ArtifactHighlightItem,
  ArtifactKeywordItem,
  ArtifactOutlineItem,
  ArtifactTranscriptSegment,
} from './types'

export class ArtifactsError extends Error {
  statusCode: number
  code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.name = 'ArtifactsError'
    this.statusCode = statusCode
    this.code = code
  }
}

export async function resolveContentBySource(
  supabase: SupabaseClient,
  userId: string,
  service: string,
  sourceRef: string,
  pageNumber?: string | null,
): Promise<ContentRow | null> {
  // 分 P 视频的 source_page 可能因 URL 带不带 ?p= 而不一致：先精确匹配，再回退 null
  const candidates = pageNumber ? [pageNumber, null] : [null]
  for (const sourcePage of candidates) {
    let match = supabase
      .from('contents')
      .select('*')
      .eq('user_id', userId)
      .eq('service', service)
      .eq('source_ref', sourceRef)
    match = sourcePage === null ? match.is('source_page', null) : match.eq('source_page', sourcePage)
    const { data, error } = await match.maybeSingle()
    if (error) {
      throw error
    }
    if (data) {
      return data as ContentRow
    }
  }
  return null
}

type DbTranscript = {
  summaryId: string | null
  id: string | null
  lang: string | null
  fullText: string | null
  segments: ArtifactTranscriptSegment[]
}

async function loadLatestTranscript(supabase: SupabaseClient, contentId: string): Promise<DbTranscript | null> {
  // 跟随最新 summary 的 transcript_id，与 history 详情口径一致；无 summary 时回退最新 transcript
  const latestSummary = await supabase
    .from('summaries')
    .select('id, transcript_id')
    .eq('content_id', contentId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestSummary.error) {
    throw latestSummary.error
  }
  const summary = latestSummary.data as Pick<SummaryRow, 'id' | 'transcript_id'> | null

  let transcriptRow: TranscriptRow | null = null
  if (summary?.transcript_id) {
    const result = await supabase.from('transcripts').select('*').eq('id', summary.transcript_id).maybeSingle()
    if (result.error) {
      throw result.error
    }
    transcriptRow = (result.data as TranscriptRow | null) ?? null
  }
  if (!transcriptRow) {
    const fallback = await supabase
      .from('transcripts')
      .select('*')
      .eq('content_id', contentId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (fallback.error) {
      throw fallback.error
    }
    transcriptRow = (fallback.data as TranscriptRow | null) ?? null
  }

  if (!transcriptRow && !summary) {
    return null
  }

  const segments: ArtifactTranscriptSegment[] = []
  if (transcriptRow) {
    const rows = await supabase
      .from('transcript_segments')
      .select('idx, start, end, text, speaker')
      .eq('transcript_id', transcriptRow.id)
      .order('idx', { ascending: true })
    if (rows.error) {
      throw rows.error
    }
    for (const row of (rows.data ?? []) as Array<
      Pick<TranscriptSegmentRow, 'idx' | 'start' | 'end' | 'text' | 'speaker'>
    >) {
      segments.push({ idx: row.idx, start: row.start, end: row.end, text: row.text, speaker: row.speaker })
    }
  }

  return {
    summaryId: summary?.id ?? null,
    id: transcriptRow?.id ?? null,
    lang: transcriptRow?.lang ?? null,
    fullText: transcriptRow?.full_text ?? null,
    segments,
  }
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function clampSeconds(value: number, duration: number | null): number {
  const clamped = Math.max(0, value)
  return duration !== null && Number.isFinite(duration) ? Math.min(clamped, Math.max(0, duration)) : clamped
}

function coerceGeneratedChapters(
  raw: RawGeneratedArtifacts['chapters'],
  duration: number | null,
): Array<{ title: string; start: number; end: number | null; summary: string | null }> {
  const items = raw
    .map((chapter) => ({
      title: typeof chapter.title === 'string' ? chapter.title.trim() : '',
      start: toFiniteNumber(chapter.start),
      end: toFiniteNumber(chapter.end),
      summary: typeof chapter.summary === 'string' && chapter.summary.trim() ? chapter.summary.trim() : null,
    }))
    .filter(
      (chapter): chapter is { title: string; start: number; end: number | null; summary: string | null } =>
        Boolean(chapter.title) && chapter.start !== null,
    )
    .sort((a, b) => a.start - b.start)
    .slice(0, 12)

  // 首章不丢：强制从 0 开始；end 补齐到下一章起点或视频时长
  return items.map((chapter, position) => {
    const start = position === 0 ? 0 : clampSeconds(chapter.start, duration)
    const nextStart = items[position + 1] ? clampSeconds(items[position + 1].start, duration) : null
    let end = chapter.end !== null ? clampSeconds(chapter.end, duration) : nextStart ?? duration
    if (end !== null && end <= start) {
      end =
        nextStart !== null && nextStart > start ? nextStart : duration !== null && duration > start ? duration : start
    }
    return { title: chapter.title, start, end, summary: chapter.summary }
  })
}

function coerceHighlights(
  raw: RawGeneratedArtifacts['highlights'],
  duration: number | null,
): Array<{ text: string; start: number; end: number | null; note: string | null }> {
  return raw
    .map((highlight) => ({
      text: typeof highlight.text === 'string' ? highlight.text.trim() : '',
      start: toFiniteNumber(highlight.start),
      end: toFiniteNumber(highlight.end),
      note: typeof highlight.note === 'string' && highlight.note.trim() ? highlight.note.trim() : null,
    }))
    .filter(
      (highlight): highlight is { text: string; start: number; end: number | null; note: string | null } =>
        Boolean(highlight.text) && highlight.start !== null,
    )
    .sort((a, b) => a.start - b.start)
    .slice(0, 10)
    .map((highlight) => ({
      text: highlight.text,
      start: clampSeconds(highlight.start, duration),
      end: highlight.end !== null && highlight.end > highlight.start ? clampSeconds(highlight.end, duration) : null,
      note: highlight.note,
    }))
}

function coerceKeywords(raw: RawGeneratedArtifacts['keywords']): string[] {
  const terms = raw.map((keyword) => (typeof keyword?.term === 'string' ? keyword.term.trim() : '')).filter(Boolean)
  return Array.from(new Set(terms)).slice(0, 12)
}

function coerceOutline(
  raw: RawGeneratedArtifacts['outline'],
  duration: number | null,
): Array<{ level: number; title: string; start: number | null; end: number | null }> {
  return raw
    .map((item) => ({
      level: toFiniteNumber(item.level) === 2 ? 2 : 1,
      title: typeof item.title === 'string' ? item.title.trim() : '',
      start: toFiniteNumber(item.start),
      end: toFiniteNumber(item.end),
    }))
    .filter((item) => Boolean(item.title))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
    .slice(0, 30)
    .map((item) => ({
      level: item.level,
      title: item.title,
      start: item.start !== null ? clampSeconds(item.start, duration) : null,
      end: item.end !== null ? clampSeconds(item.end, duration) : null,
    }))
}

function buildPlatformChapterItems(
  platformChapters: SourceChapter[],
  duration: number | null,
  index: SegmentIndex,
): ArtifactChapterItem[] {
  return platformChapters
    .filter((chapter) => typeof chapter.title === 'string' && Boolean(chapter.title.trim()))
    .sort((a, b) => a.start - b.start)
    .map((chapter, position) => {
      const start = Math.max(0, chapter.start)
      const nextStart = platformChapters[position + 1]?.start ?? null
      const rawEnd = chapter.end !== undefined && chapter.end > start ? chapter.end : nextStart ?? duration
      const end = rawEnd !== null && rawEnd !== undefined && rawEnd > start ? rawEnd : null
      return {
        idx: position,
        title: chapter.title.trim(),
        start,
        end,
        summary: null,
        source: 'platform' as const,
        segmentIds: index.segmentIdsForRange(start, end),
      }
    })
}

function sourceErrorToMissingReason(error: unknown): string {
  if (error instanceof SourceError) {
    if (error.code === 'NO_TRANSCRIPT') {
      return `该视频没有可用字幕（${error.message}）`
    }
    if (error.code === 'AUTH_REQUIRED') {
      return `获取字幕需要登录源平台（${error.message}）`
    }
    if (error.code === 'RATE_LIMITED') {
      return `源平台限流，稍后重试（${error.message}）`
    }
    return `源平台暂时不可用（${error.message}）`
  }
  return error instanceof Error ? error.message : '获取字幕失败'
}

export type GenerateArtifactsParams = {
  supabase: SupabaseClient
  userId: string
  videoUrl: string
  pageNumber?: string | null
  contentId?: string | null
  model?: string
  baseUrl?: string
  /** true 时跳过幂等检查，强制追加新版本（用户显式重新生成） */
  force?: boolean
}

/** 生成章节/重点/关键词/大纲 artifacts 并落库，返回前端可直接渲染的 bundle */
export async function generateArtifactsBundle(params: GenerateArtifactsParams): Promise<ArtifactBundle> {
  const { supabase, userId, videoUrl, pageNumber } = params
  const parsed = parseVideoSourceUrl(videoUrl)
  if (!parsed) {
    throw new ArtifactsError(400, 'BAD_REQUEST', '无法解析视频链接，仅支持 YouTube / Bilibili')
  }

  const content = params.contentId
    ? await (async () => {
        const { data, error } = await supabase
          .from('contents')
          .select('*')
          .eq('id', params.contentId)
          .eq('user_id', userId)
          .maybeSingle()
        if (error) {
          throw error
        }
        return (data as ContentRow | null) ?? null
      })()
    : await resolveContentBySource(supabase, userId, parsed.adapter.id, parsed.videoId, pageNumber ?? null)
  if (params.contentId && !content) {
    throw new ArtifactsError(404, 'NOT_FOUND', '内容不存在或不属于当前用户')
  }
  if (!content) {
    throw new ArtifactsError(
      404,
      'CONTENT_NOT_PERSISTED',
      '该视频还没有入库摘要（登录后完成一次摘要，即可生成章节与重点）',
    )
  }

  const dbTranscript = await loadLatestTranscript(supabase, content.id)

  // 平台原始 chapters 与直播转录都来自 source adapter；DB 已有转录时失败可容忍
  let liveDoc: MediaDocument | null = null
  try {
    liveDoc = await parsed.adapter.fetch(videoUrl)
  } catch (error) {
    if (!dbTranscript?.segments.length) {
      throw new ArtifactsError(422, 'NO_TRANSCRIPT', sourceErrorToMissingReason(error))
    }
    console.warn(
      `[artifacts] live fetch failed but DB transcript exists: ${error instanceof Error ? error.message : error}`,
    )
  }

  const segments: TranscriptSegment[] = dbTranscript?.segments.length
    ? dbTranscript.segments.map((segment) => ({
        start: Number(segment.start ?? 0),
        end: Number(segment.end ?? segment.start ?? 0),
        text: segment.text,
        speaker: segment.speaker ?? undefined,
      }))
    : liveDoc?.transcript ?? []
  if (!segments.length) {
    throw new ArtifactsError(
      422,
      'NO_TRANSCRIPT',
      dbTranscript?.fullText ? '该视频没有字幕，此前的摘要基于视频简介生成，无法定位章节时间点' : '该视频没有可用字幕',
    )
  }

  const index = new SegmentIndex(
    segments.map((segment, position) => ({
      idx: position,
      start: segment.start,
      end: segment.end,
      text: segment.text,
    })),
  )
  const duration = content.duration ?? liveDoc?.duration ?? index.lastEnd

  // highlights/keywords/outline 始终由模型生成；chapters 有平台原始章节时优先保留（标注来源），否则用模型结果
  const platformChapters = liveDoc?.chapters ?? []
  const chapterSource: ArtifactChapterSource = platformChapters.length ? 'platform' : 'generated'
  const apiKey = await selectApiKeyAndActivatedLicenseKey(undefined, parsed.videoId)
  const generated = await generateStructuredArtifacts({
    title: content.title ?? liveDoc?.title ?? null,
    segments: index,
    model: params.model,
    baseUrl: params.baseUrl,
    apiKey,
  })

  const chapterItems: ArtifactChapterItem[] =
    chapterSource === 'platform'
      ? buildPlatformChapterItems(platformChapters, duration ?? null, index)
      : coerceGeneratedChapters(generated.chapters, duration ?? null).map((chapter, position) => ({
          idx: position,
          title: chapter.title,
          start: chapter.start,
          end: chapter.end,
          summary: chapter.summary,
          source: 'generated' as const,
          segmentIds: index.segmentIdsForRange(chapter.start, chapter.end),
        }))

  const highlightItems: ArtifactHighlightItem[] = coerceHighlights(generated.highlights, duration ?? null).map(
    (highlight, position) => ({
      idx: position,
      text: highlight.text,
      start: highlight.start,
      end: highlight.end,
      note: highlight.note,
      segmentIds: index.segmentIdsForRange(highlight.start, highlight.end),
    }),
  )

  // 关键词跨全片，不绑定具体 segment
  const keywordItems: ArtifactKeywordItem[] = coerceKeywords(generated.keywords).map((term) => ({
    term,
    segmentIds: [],
  }))

  const outlineItems: ArtifactOutlineItem[] = coerceOutline(generated.outline, duration ?? null).map((item) => ({
    level: item.level,
    title: item.title,
    start: item.start,
    end: item.end,
    segmentIds: index.segmentIdsForRange(item.start, item.end),
  }))

  const transcriptId = dbTranscript?.id ?? null
  const persistResult = await persistArtifacts({
    supabase,
    userId,
    contentId: content.id,
    summaryId: dbTranscript?.summaryId ?? null,
    transcriptId,
    chapterSource,
    chapters: chapterItems,
    highlights: highlightItems,
    keywords: keywordItems,
    outline: outlineItems,
    model: params.model ?? null,
    segmentCount: segments.length,
    force: params.force,
  })

  const transcriptSegments: ArtifactTranscriptSegment[] = segments.map((segment, position) => ({
    idx: position,
    start: segment.start,
    end: segment.end,
    text: segment.text,
    speaker: segment.speaker ?? null,
  }))

  return {
    contentId: content.id,
    summaryId: dbTranscript?.summaryId ?? null,
    chapterSource,
    generatedAt: new Date().toISOString(),
    reused: persistResult.reused,
    chapters: chapterItems,
    highlights: highlightItems,
    keywords: keywordItems,
    outline: outlineItems,
    transcript: {
      id: transcriptId,
      lang: dbTranscript?.lang ?? liveDoc?.language ?? null,
      fullText: dbTranscript?.fullText ?? null,
      segments: transcriptSegments,
    },
    transcriptMissingReason: null,
  }
}
