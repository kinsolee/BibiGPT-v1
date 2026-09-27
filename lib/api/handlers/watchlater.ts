import type { NextApiRequest, NextApiResponse } from 'next'
import type { V1Deps } from '../deps'
import { V1Error, sendV1Error } from '../errors'
import { applyV1Cors, sendV1MethodNotAllowed } from '../http'
import { authenticateV1, checkRateLimit } from './common'

export interface V1WatchLaterItem {
  id: string
  sourceUrl: string | null
  service: string | null
  title: string | null
  status: string
  position: number
  contentId: string | null
  jobId: string | null
  errorCode: string | null
  errorMessage: string | null
  addedAt: string
  finishedAt: string | null
}

export interface V1WatchLaterCursor {
  addedAt: string
  position: number
}

export interface V1WatchLaterListResult {
  items: V1WatchLaterItem[]
  nextCursor: V1WatchLaterCursor | null
  collection: { id: string; title: string; batchStatus: string }
}

/** watch-later 读取由路由层注入（默认实现 lib/api/watchLaterReader.ts） */
export interface V1WatchLaterReader {
  list(userId: string, options: { cursor: V1WatchLaterCursor | null; limit: number }): Promise<V1WatchLaterListResult>
}

export const DEFAULT_WATCH_LATER_PAGE_LIMIT = 50
export const MAX_WATCH_LATER_PAGE_LIMIT = 100

/** GET /api/v1/watch-later?limit=&cursor= → { items, cursor?, collection } */
export async function handleV1WatchLaterList(
  req: NextApiRequest,
  res: NextApiResponse,
  deps: V1Deps,
  reader: V1WatchLaterReader,
): Promise<void> {
  if (applyV1Cors(req, res)) {
    return
  }
  if (req.method !== 'GET') {
    sendV1MethodNotAllowed(res, 'GET')
    return
  }
  const auth = await authenticateV1(req, res, deps)
  if (!auth) {
    return
  }
  if (!(await checkRateLimit(auth, res, deps.rateLimiter))) {
    return
  }
  const limitInput = Number(req.query.limit)
  const limit =
    Number.isInteger(limitInput) && limitInput >= 1
      ? Math.min(limitInput, MAX_WATCH_LATER_PAGE_LIMIT)
      : DEFAULT_WATCH_LATER_PAGE_LIMIT
  let cursor: V1WatchLaterCursor | null = null
  const cursorRaw = typeof req.query.cursor === 'string' ? req.query.cursor : undefined
  if (cursorRaw) {
    const parsed = decodeWatchLaterCursor(cursorRaw)
    if (!parsed) {
      sendV1Error(res, new V1Error('INVALID_REQUEST', 'malformed cursor'))
      return
    }
    cursor = parsed
  }
  const result = await reader.list(auth.userId, { cursor, limit }).catch(() => null)
  if (!result) {
    sendV1Error(res, new V1Error('INTERNAL', 'watch-later list failed'))
    return
  }
  res.status(200).json({
    items: result.items,
    ...(result.nextCursor ? { cursor: encodeWatchLaterCursor(result.nextCursor) } : {}),
    collection: result.collection,
  })
}

/** cursor 为 base64url(JSON {addedAt, position})，配合 (added_at, position) 稳定排序 */
export function encodeWatchLaterCursor(cursor: V1WatchLaterCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeWatchLaterCursor(raw: string): V1WatchLaterCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      addedAt?: unknown
      position?: unknown
    }
    if (typeof parsed.addedAt !== 'string' || typeof parsed.position !== 'number') {
      return null
    }
    return { addedAt: parsed.addedAt, position: parsed.position }
  } catch {
    return null
  }
}
