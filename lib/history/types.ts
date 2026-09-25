// KIN-41 历史记录模块类型。
// 注意：TranscriptSegment / MediaDocument 是并行任务 KIN-38 在 lib/sources/types.ts
// 拥有的契约的最小镜像（字段名必须对齐：start/end/text/lang/speaker/sourceRef），
// 待 KIN-38 合并后应替换为直接 import。

export type TranscriptSegment = {
  start: number
  end: number | null
  text: string
  lang?: string
  speaker?: string
  sourceRef?: string
}

export type MediaDocumentMetadata = {
  sourceUrl: string
  service: string
  sourceRef: string
  sourcePage: string | null
  title: string | null
  duration: number | null
  language: string | null
}

/** contents 行（数据库 snake_case 原样返回） */
export type ContentRow = {
  id: string
  user_id: string
  source_url: string
  service: string
  source_ref: string
  source_page: string | null
  title: string | null
  duration: number | null
  language: string | null
  source_metadata: Record<string, unknown>
  is_favorite: boolean
  last_summarized_at: string | null
  created_at: string
  updated_at: string
}

export type SummaryRow = {
  id: string
  user_id: string
  content_id: string
  transcript_id: string | null
  config: Record<string, unknown>
  model: string | null
  prompt_version: string
  status: string
  error: string | null
  input_hash: string
  version: number
  content_text: string | null
  created_at: string
  updated_at: string
}

export type TranscriptRow = {
  id: string
  user_id: string
  content_id: string
  lang: string | null
  source: string | null
  source_ref: string | null
  full_text: string | null
  segment_count: number
  input_hash: string
  created_at: string
}

export type TranscriptSegmentRow = {
  id: string
  transcript_id: string
  idx: number
  start: number | null
  end: number | null
  text: string
  lang: string | null
  speaker: string | null
  source_ref: string | null
}

export type ChapterRow = {
  id: string
  content_id: string
  idx: number
  start: number | null
  end: number | null
  title: string | null
  summary: string | null
}

export type HighlightRow = {
  id: string
  content_id: string
  idx: number
  start: number | null
  end: number | null
  text: string
  note: string | null
}

export type ArtifactRow = {
  id: string
  content_id: string
  summary_id: string | null
  kind: string
  version: number
  payload: Record<string, unknown>
  refs: Record<string, unknown>
  created_at: string
}

/** 供客户端使用的 camelCase DTO */

export type HistorySummaryDTO = {
  id: string
  version: number
  config: Record<string, unknown>
  model: string | null
  status: string
  contentText: string | null
  createdAt: string
}

export type HistoryListItemDTO = {
  id: string
  title: string | null
  service: string
  sourceUrl: string
  sourceRef: string
  sourcePage: string | null
  language: string | null
  isFavorite: boolean
  createdAt: string
  lastSummarizedAt: string | null
  summary: HistorySummaryDTO | null
}

export type HistoryListResponse = {
  items: HistoryListItemDTO[]
  total: number
  page: number
  pageSize: number
}

export type HistoryDetailDTO = {
  content: HistoryListItemDTO
  summaries: HistorySummaryDTO[]
  transcript: {
    id: string
    lang: string | null
    fullText: string | null
    segmentCount: number
    createdAt: string
    segments: Array<{ idx: number; start: number | null; end: number | null; text: string; speaker: string | null }>
  } | null
  chapters: Array<{
    idx: number
    start: number | null
    end: number | null
    title: string | null
    summary: string | null
  }>
  highlights: Array<{ idx: number; start: number | null; end: number | null; text: string; note: string | null }>
  artifacts: Array<{ id: string; kind: string; version: number; payload: Record<string, unknown>; createdAt: string }>
}
