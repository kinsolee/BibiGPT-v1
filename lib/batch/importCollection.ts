import type { SupabaseClient } from '@supabase/supabase-js'
import { extractBilibiliCollectionRef, parseBilibiliCollection } from './bilibiliCollection'
import { extractYoutubePlaylistId, parseYoutubePlaylist } from './youtubePlaylist'
import { BatchError } from './types'
import type { BatchCollectionRow, CanonicalBatchItem, ParsedCollectionSource } from './types'

const UNSUPPORTED_MESSAGE =
  '暂不支持的链接。目前支持：YouTube 播放列表（youtube.com/playlist?list=…）、' +
  'B 站收藏夹（space.bilibili.com/{mid}/favlist?fid=…）与 B 站合集（…/collectiondetail?sid=…）'

export type DetectedCollectionKind = 'youtube_playlist' | 'bilibili_collection'

export async function parseCollectionSource(rawUrl: string): Promise<ParsedCollectionSource> {
  const youtubeListId = extractYoutubePlaylistId(rawUrl)
  if (youtubeListId) {
    return parseYoutubePlaylist(youtubeListId)
  }
  const bilibiliRef = extractBilibiliCollectionRef(rawUrl)
  if (bilibiliRef) {
    return parseBilibiliCollection(bilibiliRef)
  }
  throw new BatchError('UNSUPPORTED_URL', UNSUPPORTED_MESSAGE)
}

export interface ImportCollectionResult {
  collection: BatchCollectionRow
  imported: number
  /** 请求内去重 + 与既有 item 去重（含超出 50 上限）合计丢弃数 */
  duplicates: number
}

function toItemRows(userId: string, collectionId: string, items: CanonicalBatchItem[]): Array<Record<string, unknown>> {
  return items.map((item, index) => ({
    user_id: userId,
    collection_id: collectionId,
    position: index,
    dedupe_key: item.dedupeKey,
    source_url: item.sourceUrl,
    service: item.service,
    title: item.title || null,
    status: 'pending',
  }))
}

/** 解析 playlist/collection 链接并落库为 collection + pending items；不触发任何总结 */
export async function importCollectionFromUrl(
  supabase: SupabaseClient,
  userId: string,
  rawUrl: string,
): Promise<ImportCollectionResult> {
  const parsed = await parseCollectionSource(rawUrl)

  const insertedCollection = await supabase
    .from('collections')
    .insert({
      user_id: userId,
      title: parsed.title,
      kind: parsed.kind,
      source_url: rawUrl,
      service: parsed.service,
      external_id: parsed.externalId,
      batch_status: 'idle',
    })
    .select('*')
    .single()
  if (insertedCollection.error) {
    throw insertedCollection.error
  }
  const collection = insertedCollection.data as BatchCollectionRow

  // 同请求内唯一 + (collection_id, dedupe_key) 部分唯一索引兜底历史重复
  const rows = toItemRows(userId, collection.id, parsed.items)
  const insertedItems = await supabase
    .from('collection_items')
    .upsert(rows, { ignoreDuplicates: true, onConflict: 'collection_id,dedupe_key' })
    .select('id')
  if (insertedItems.error) {
    // 集合已建但 items 写入失败：回滚集合行，避免留下空批次
    await supabase.from('collections').delete().eq('id', collection.id)
    throw insertedItems.error
  }

  const imported = insertedItems.data?.length ?? 0
  return {
    collection,
    imported,
    duplicates: parsed.items.length - imported,
  }
}
