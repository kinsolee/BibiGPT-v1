import { ContentRow, HistoryListItemDTO, HistorySummaryDTO, SummaryRow } from './types'

export function toSummaryDTO(row: SummaryRow): HistorySummaryDTO {
  return {
    id: row.id,
    version: row.version,
    config: row.config,
    model: row.model,
    status: row.status,
    contentText: row.content_text,
    transcriptId: row.transcript_id,
    createdAt: row.created_at,
  }
}

export function toListItem(content: ContentRow, latestSummary: SummaryRow | null): HistoryListItemDTO {
  return {
    id: content.id,
    title: content.title,
    service: content.service,
    sourceUrl: content.source_url,
    sourceRef: content.source_ref,
    sourcePage: content.source_page,
    language: content.language,
    isFavorite: content.is_favorite,
    createdAt: content.created_at,
    lastSummarizedAt: content.last_summarized_at,
    summary: latestSummary ? toSummaryDTO(latestSummary) : null,
  }
}
