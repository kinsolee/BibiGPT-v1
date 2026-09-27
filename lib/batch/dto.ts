import type { NextApiRequest, NextApiResponse } from 'next'
import { BatchError } from './types'
import type { BatchCollectionRow, BatchItemRow, BatchItemStatus, BatchStatus } from './types'

export interface BatchItemDTO {
  id: string
  position: number
  title: string | null
  sourceUrl: string | null
  service: string | null
  dedupeKey: string | null
  status: BatchItemStatus
  attempts: number
  errorCode: string | null
  errorMessage: string | null
  contentId: string | null
  jobId: string | null
  addedAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface BatchStatusCounts {
  total: number
  pending: number
  queued: number
  running: number
  succeeded: number
  failed: number
  canceled: number
}

export interface BatchCollectionDTO {
  id: string
  kind: string
  title: string
  sourceUrl: string | null
  service: string | null
  externalId: string | null
  batchStatus: BatchStatus
  createdAt: string
  counts: BatchStatusCounts
}

export interface BatchCollectionDetailDTO extends BatchCollectionDTO {
  items: BatchItemDTO[]
}

export function toItemDTO(row: BatchItemRow): BatchItemDTO {
  return {
    id: row.id,
    position: row.position,
    title: row.title,
    sourceUrl: row.source_url,
    service: row.service,
    dedupeKey: row.dedupe_key,
    status: row.status,
    attempts: row.attempts,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    contentId: row.content_id,
    jobId: row.job_id,
    addedAt: row.added_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

export function countItemStatuses(items: BatchItemRow[]): BatchStatusCounts {
  const counts: BatchStatusCounts = {
    total: items.length,
    pending: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    canceled: 0,
  }
  for (const item of items) {
    counts[item.status] += 1
  }
  return counts
}

export function toCollectionDTO(row: BatchCollectionRow, items: BatchItemRow[] = []): BatchCollectionDTO {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    sourceUrl: row.source_url,
    service: row.service,
    externalId: row.external_id,
    batchStatus: row.batch_status,
    createdAt: row.created_at,
    counts: countItemStatuses(items),
  }
}

export function toCollectionDetailDTO(row: BatchCollectionRow, items: BatchItemRow[]): BatchCollectionDetailDTO {
  return {
    ...toCollectionDTO(row, items),
    items: items.map(toItemDTO),
  }
}

/** BatchError → HTTP 响应；其余归 500 */
export function batchErrorResponse(res: NextApiResponse, error: unknown): void {
  if (error instanceof BatchError) {
    res.status(error.httpStatus).json({ error: error.code, message: error.message })
    return
  }
  console.error('[batch] api error:', error)
  res.status(500).json({ error: 'internal_error', message: (error as Error)?.message ?? 'Internal Server Error' })
}

export async function readJsonBody<T>(req: NextApiRequest): Promise<T | undefined> {
  if (req.body && typeof req.body === 'object') {
    return req.body as T
  }
  return undefined
}
