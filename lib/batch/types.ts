/** 单次导入/批量的硬上限（issue 验收标准） */
export const BATCH_MAX_ITEMS = 50

export type BatchCollectionKind = 'manual' | 'youtube_playlist' | 'bilibili_collection' | 'watch_later'

/** 与 lib/jobs JobStatus 对齐的词表，另加 imported-not-started 的 pending */
export type BatchItemStatus = 'pending' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export type BatchStatus = 'idle' | 'running' | 'paused'

/** 未开始/等待调度的项都可被 worker 认领；running 为上一轮崩溃遗留的陈旧状态，同样可续传 */
export const RUNNABLE_ITEM_STATUSES: ReadonlyArray<BatchItemStatus> = ['pending', 'queued', 'running']

export interface CanonicalBatchItem {
  sourceUrl: string
  service: 'youtube' | 'bilibili'
  /** 规范化 sourceRef（youtube:video:{id} / bilibili:video:{bv}），同 collection 内去重键 */
  dedupeKey: string
  title: string
  pageNumber?: string
}

export interface ParsedCollectionSource {
  kind: 'youtube_playlist' | 'bilibili_collection'
  service: 'youtube' | 'bilibili'
  externalId: string
  title: string
  items: CanonicalBatchItem[]
}

export interface BatchCollectionRow {
  id: string
  user_id: string
  title: string
  description: string | null
  kind: BatchCollectionKind
  source_url: string | null
  service: string | null
  external_id: string | null
  batch_status: BatchStatus
  created_at: string
}

export interface BatchItemRow {
  id: string
  user_id: string
  collection_id: string
  content_id: string | null
  added_at: string
  position: number
  dedupe_key: string | null
  source_url: string | null
  service: string | null
  title: string | null
  status: BatchItemStatus
  job_id: string | null
  error_code: string | null
  error_message: string | null
  attempts: number
  started_at: string | null
  finished_at: string | null
}

export type BatchErrorCode =
  | 'UNSUPPORTED_URL'
  | 'PARSE_FAILED'
  | 'TOO_MANY_ITEMS'
  | 'NOT_FOUND'
  | 'ALREADY_RUNNING'
  | 'INVALID_STATE'
  | 'INTERNAL_ERROR'

export class BatchError extends Error {
  readonly code: BatchErrorCode
  readonly httpStatus: number

  constructor(code: BatchErrorCode, message: string, httpStatus?: number) {
    super(message)
    this.name = 'BatchError'
    this.code = code
    this.httpStatus = httpStatus ?? defaultHttpStatus(code)
  }
}

function defaultHttpStatus(code: BatchErrorCode): number {
  switch (code) {
    case 'UNSUPPORTED_URL':
    case 'INVALID_STATE':
      return 400
    case 'PARSE_FAILED':
      return 502
    case 'TOO_MANY_ITEMS':
      return 413
    case 'NOT_FOUND':
      return 404
    case 'ALREADY_RUNNING':
      return 409
    case 'INTERNAL_ERROR':
      return 500
  }
}
