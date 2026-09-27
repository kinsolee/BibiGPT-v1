import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSourceUrl } from '~/lib/history/adapters'
import { parseVideoSourceUrl } from '~/lib/sources/registry'
import { buildBilibiliSourceRef, buildYoutubeSourceRef } from '~/lib/sources/sourceRef'
import type { BatchCollectionRow, CanonicalBatchItem } from './types'
import { dedupeAndCapItems } from './dedupe'

export const WATCH_LATER_TITLE = '稍后再看'

/** 每个用户一个 watch_later 集合，首次使用时懒创建 */
export async function getOrCreateWatchLaterCollection(
  supabase: SupabaseClient,
  userId: string,
): Promise<BatchCollectionRow> {
  const existing = await supabase
    .from('collections')
    .select('*')
    .eq('user_id', userId)
    .eq('kind', 'watch_later')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (existing.error) {
    throw existing.error
  }
  if (existing.data) {
    return existing.data as BatchCollectionRow
  }
  const inserted = await supabase
    .from('collections')
    .insert({ user_id: userId, title: WATCH_LATER_TITLE, kind: 'watch_later', batch_status: 'idle' })
    .select('*')
    .single()
  if (inserted.error) {
    // 并发首建撞唯一/约束时回读
    const again = await supabase
      .from('collections')
      .select('*')
      .eq('user_id', userId)
      .eq('kind', 'watch_later')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (again.error || !again.data) {
      throw again.error ?? inserted.error
    }
    return again.data as BatchCollectionRow
  }
  return inserted.data as BatchCollectionRow
}

function canonicalItemFromUrl(rawUrl: string): CanonicalBatchItem | undefined {
  const parsed = parseVideoSourceUrl(rawUrl)
  if (!parsed) {
    return undefined
  }
  const service = parsed.adapter.id === 'youtube' ? 'youtube' : 'bilibili'
  const dedupeKey =
    service === 'youtube'
      ? buildYoutubeSourceRef(parsed.videoId)
      : buildBilibiliSourceRef(parsed.videoId, parsed.pageNumber ?? null)
  return {
    sourceUrl: buildSourceUrl(parsed.videoId, service, parsed.pageNumber ?? null),
    service,
    dedupeKey,
    title: '',
    pageNumber: parsed.pageNumber,
  }
}

export interface AddWatchLaterResult {
  collection: BatchCollectionRow
  added: number
  duplicates: number
  invalidUrls: string[]
}

/**
 * Watch Later 添加入口（供浏览器扩展 / 移动端共用）：
 * 只解析单视频 URL 并登记为 pending item，绝不自动触发总结。
 */
export async function addWatchLaterItems(
  supabase: SupabaseClient,
  userId: string,
  urls: string[],
): Promise<AddWatchLaterResult> {
  const collection = await getOrCreateWatchLaterCollection(supabase, userId)

  const invalidUrls: string[] = []
  const candidates: CanonicalBatchItem[] = []
  for (const rawUrl of urls) {
    const item = canonicalItemFromUrl(rawUrl.trim())
    if (!item) {
      invalidUrls.push(rawUrl)
      continue
    }
    candidates.push(item)
  }

  const { items, duplicates: inRequestDuplicates } = dedupeAndCapItems(candidates)
  if (!items.length) {
    return { collection, added: 0, duplicates: 0, invalidUrls }
  }

  const rows = items.map((item, index) => ({
    user_id: userId,
    collection_id: collection.id,
    position: index,
    dedupe_key: item.dedupeKey,
    source_url: item.sourceUrl,
    service: item.service,
    title: null,
    status: 'pending',
  }))
  const inserted = await supabase
    .from('collection_items')
    .upsert(rows, { ignoreDuplicates: true, onConflict: 'collection_id,dedupe_key' })
    .select('id')
  if (inserted.error) {
    throw inserted.error
  }
  const added = inserted.data?.length ?? 0
  return {
    collection,
    added,
    duplicates: inRequestDuplicates + (items.length - added),
    invalidUrls,
  }
}
