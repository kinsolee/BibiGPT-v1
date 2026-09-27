import { addWatchLaterItems, getOrCreateWatchLaterCollection } from '~/lib/batch/watchLater'
import { redactSecrets } from '~/lib/models/errors'
import { getServiceSupabase } from './supabaseService'
import { V1Error } from './errors'
import type { V1Importer } from './handlers/import'

/**
 * 默认 importer：只读复用 lib/batch 的 watch-later 写入（getOrCreate +
 * addWatchLaterItems upsert ignoreDuplicates），不 HTTP 自调、不复制实现。
 * upsert 冲突行不回传，因此先查已有 dedupe_key 再写入，保证 duplicates 精确。
 */
export const defaultV1Importer: V1Importer = async (userId, items) => {
  const supabase = getServiceSupabase()
  if (!supabase) {
    throw new V1Error('INTERNAL', 'database unavailable: set SUPABASE_SERVICE_ROLE_KEY')
  }
  const collection = await getOrCreateWatchLaterCollection(supabase, userId)
  const keys = items.map((item) => item.dedupeKey)
  const existing = new Set<string>()
  if (keys.length > 0) {
    const { data, error } = await supabase
      .from('collection_items')
      .select('dedupe_key')
      .eq('collection_id', collection.id)
      .in('dedupe_key', keys)
    if (error) {
      throw error
    }
    for (const row of (data ?? []) as Array<{ dedupe_key: string | null }>) {
      if (row.dedupe_key) {
        existing.add(row.dedupe_key)
      }
    }
  }
  const pending = items.filter((item) => !existing.has(item.dedupeKey))
  if (pending.length > 0) {
    const result = await addWatchLaterItems(
      supabase,
      userId,
      pending.map((item) => item.rawUrl),
    )
    if (result.added < pending.length) {
      console.error(
        `[v1] watch-later upsert added ${result.added}/${pending.length}: ${redactSecrets(
          String(result.invalidUrls.length),
        )} invalid`,
      )
    }
  }

  const contentIds = new Map<string, string | null>()
  if (keys.length > 0) {
    const { data, error } = await supabase
      .from('contents')
      .select('id, source_ref')
      .eq('user_id', userId)
      .in('source_ref', keys)
    if (error) {
      throw error
    }
    for (const row of (data ?? []) as Array<{ id: string; source_ref: string }>) {
      contentIds.set(row.source_ref, row.id)
    }
  }
  const contentIdByDedupeKey: Record<string, string | null> = {}
  for (const item of items) {
    contentIdByDedupeKey[item.dedupeKey] = contentIds.get(item.dedupeKey) ?? null
  }
  return { writtenKeys: pending.map((item) => item.dedupeKey), contentIdByDedupeKey }
}
