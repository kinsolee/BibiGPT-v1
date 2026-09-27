import { buildBilibiliSourceRef } from '~/lib/sources/sourceRef'
import { buildSignedBilibiliUrl } from './bilibiliWbi'
import { BATCH_MAX_ITEMS, BatchError } from './types'
import type { CanonicalBatchItem, ParsedCollectionSource } from './types'
import { dedupeAndCapItems } from './dedupe'

const REQUEST_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://space.bilibili.com/',
}

function bilibiliRequestError(code: number, message: string, what: string): BatchError {
  if (code === -403 || code === -111 || code === -101) {
    return new BatchError(
      'PARSE_FAILED',
      `哔哩哔哩${what}需要登录才能查看（code ${code}），仅支持导入公开的收藏夹/合集`,
    )
  }
  if (code === -404 || code === -352) {
    return new BatchError('PARSE_FAILED', `哔哩哔哩${what}不存在或已被删除（code ${code}），请确认链接`)
  }
  return new BatchError('PARSE_FAILED', `哔哩哔哩接口返回异常（code ${code}: ${message}）`)
}

export interface BilibiliCollectionRef {
  /** favlist = 收藏夹（fid）；season = 合集（mid + sid） */
  type: 'favlist' | 'season'
  mediaId?: string
  mid?: string
  seasonId?: string
}

export function extractBilibiliCollectionRef(rawUrl: string): BilibiliCollectionRef | undefined {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined
  }
  const host = url.hostname.replace(/^www\./, '')
  if (host !== 'bilibili.com' && host !== 'space.bilibili.com' && host !== 'm.bilibili.com') {
    return undefined
  }
  const fid = url.searchParams.get('fid')
  if (fid && /^\d+$/.test(fid)) {
    return { type: 'favlist', mediaId: fid }
  }
  const sid = url.searchParams.get('sid')
  const midFromPath = url.pathname.match(/^\/(\d+)\/channel\/collectiondetail/)
  if (sid && /^\d+$/.test(sid) && midFromPath) {
    return { type: 'season', mid: midFromPath[1], seasonId: sid }
  }
  // 纯 favlist 首页或其它空间页面：缺 fid 无法定位
  return undefined
}

function toItems(entries: Array<{ bvid?: string; title?: string }>): CanonicalBatchItem[] {
  const items: CanonicalBatchItem[] = []
  for (const entry of entries) {
    if (!entry.bvid) {
      continue
    }
    items.push({
      sourceUrl: `https://www.bilibili.com/video/${entry.bvid}`,
      service: 'bilibili',
      dedupeKey: buildBilibiliSourceRef(entry.bvid),
      title: entry.title ?? '',
    })
  }
  return items
}

async function fetchFavlist(mediaId: string): Promise<ParsedCollectionSource> {
  // fav 资源列表接口要求 Wbi 签名（无签名返回 -400），且 ps 上限 20，翻页凑满 50
  const PAGE_SIZE = 20
  const items: CanonicalBatchItem[] = []
  let title: string | undefined
  for (let pn = 1; pn <= Math.ceil(BATCH_MAX_ITEMS / PAGE_SIZE) && items.length < BATCH_MAX_ITEMS; pn += 1) {
    const url = await buildSignedBilibiliUrl('/x/v3/fav/resource/list', {
      media_id: mediaId,
      pn,
      ps: PAGE_SIZE,
      keyword: '',
      order: 'mtime',
      type: 0,
      tid: 0,
      platform: 'web',
    })
    let payload: {
      code: number
      message?: string
      data?: { info?: { title?: string }; medias?: Array<{ bvid?: string; title?: string }> }
    }
    try {
      const response = await fetch(url, { headers: REQUEST_HEADERS })
      payload = (await response.json()) as typeof payload
    } catch (error) {
      throw new BatchError('PARSE_FAILED', `哔哩哔哩收藏夹接口请求失败：${(error as Error).message}`)
    }
    if (payload.code !== 0) {
      throw bilibiliRequestError(payload.code, payload.message ?? '', `收藏夹 ${mediaId}`)
    }
    title = payload.data?.info?.title
    const medias = payload.data?.medias ?? []
    items.push(...toItems(medias))
    if (medias.length < PAGE_SIZE) {
      break
    }
  }
  if (!items.length) {
    throw new BatchError('PARSE_FAILED', `收藏夹 ${mediaId} 为空或不可见，请确认收藏夹为公开且包含视频`)
  }
  const { items: deduped, duplicates } = dedupeAndCapItems(items)
  if (duplicates > 0) {
    console.info(`[batch] bilibili favlist ${mediaId}: skipped ${duplicates} duplicate/overflow items`)
  }
  return {
    kind: 'bilibili_collection',
    service: 'bilibili',
    externalId: mediaId,
    title: title ?? `收藏夹 ${mediaId}`,
    items: deduped,
  }
}

async function fetchSeason(ref: BilibiliCollectionRef): Promise<ParsedCollectionSource> {
  const PAGE_SIZE = 20
  const items: CanonicalBatchItem[] = []
  let title: string | undefined
  for (
    let pageNum = 1;
    pageNum <= Math.ceil(BATCH_MAX_ITEMS / PAGE_SIZE) && items.length < BATCH_MAX_ITEMS;
    pageNum += 1
  ) {
    const url = await buildSignedBilibiliUrl('/x/polymer/web-space/seasons_archives_list', {
      mid: ref.mid ?? '',
      season_id: ref.seasonId ?? '',
      page_num: pageNum,
      page_size: PAGE_SIZE,
    })
    let payload: {
      code: number
      message?: string
      data?: { meta?: { name?: string }; archives?: Array<{ bvid?: string; title?: string }> }
    }
    try {
      const response = await fetch(url, { headers: REQUEST_HEADERS })
      payload = (await response.json()) as typeof payload
    } catch (error) {
      throw new BatchError('PARSE_FAILED', `哔哩哔哩合集接口请求失败：${(error as Error).message}`)
    }
    if (payload.code !== 0) {
      throw bilibiliRequestError(payload.code, payload.message ?? '', `合集 ${ref.seasonId}`)
    }
    title = payload.data?.meta?.name
    const archives = payload.data?.archives ?? []
    items.push(...toItems(archives))
    if (archives.length < PAGE_SIZE) {
      break
    }
  }
  if (!items.length) {
    throw new BatchError('PARSE_FAILED', `合集 ${ref.seasonId} 为空或不可见`)
  }
  const { items: deduped, duplicates } = dedupeAndCapItems(items)
  if (duplicates > 0) {
    console.info(`[batch] bilibili season ${ref.seasonId}: skipped ${duplicates} duplicate/overflow items`)
  }
  return {
    kind: 'bilibili_collection',
    service: 'bilibili',
    externalId: ref.seasonId ?? '',
    title: title ?? `合集 ${ref.seasonId}`,
    items: deduped,
  }
}

export async function parseBilibiliCollection(ref: BilibiliCollectionRef): Promise<ParsedCollectionSource> {
  return ref.type === 'favlist' ? fetchFavlist(ref.mediaId ?? '') : fetchSeason(ref)
}
