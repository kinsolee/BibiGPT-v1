import { getOrCreateWatchLaterCollection } from '~/lib/batch/watchLater'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { V1WatchLaterItem, V1WatchLaterReader } from './handlers/watchlater'

interface WatchLaterRow {
  id: string
  source_url: string | null
  service: string | null
  title: string | null
  status: string
  position: number
  content_id: string | null
  job_id: string | null
  error_code: string | null
  error_message: string | null
  added_at: string
  finished_at: string | null
}

function toItem(row: WatchLaterRow): V1WatchLaterItem {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    service: row.service,
    title: row.title,
    status: row.status,
    position: row.position,
    contentId: row.content_id,
    jobId: row.job_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    addedAt: row.added_at,
    finishedAt: row.finished_at,
  }
}

/** 默认 watch-later 读取：复用 KIN-45 的 collections/collection_items，(added_at, position) 游标分页 */
export function createSupabaseWatchLaterReader(supabase: SupabaseClient): V1WatchLaterReader {
  return {
    async list(userId, { cursor, limit }) {
      const collection = await getOrCreateWatchLaterCollection(supabase, userId)
      let query = supabase
        .from('collection_items')
        .select(
          'id, source_url, service, title, status, position, content_id, job_id, error_code, error_message, added_at, finished_at',
        )
        .eq('collection_id', collection.id)
      if (cursor) {
        query = query.or(
          `added_at.gt."${cursor.addedAt}",and(added_at.eq."${cursor.addedAt}",position.gt.${cursor.position})`,
        )
      }
      const { data, error } = await query
        .order('added_at', { ascending: true })
        .order('position', { ascending: true })
        .limit(limit + 1)
      if (error) {
        throw error
      }
      const rows = (data ?? []) as WatchLaterRow[]
      const hasMore = rows.length > limit
      const page = hasMore ? rows.slice(0, limit) : rows
      const last = page[page.length - 1]
      return {
        items: page.map(toItem),
        nextCursor: hasMore && last ? { addedAt: last.added_at, position: last.position } : null,
        collection: {
          id: collection.id,
          title: collection.title,
          batchStatus: collection.batch_status,
        },
      }
    },
  }
}
