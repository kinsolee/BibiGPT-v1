import { buildYoutubeSourceRef } from '~/lib/sources/sourceRef'
import { BatchError } from './types'
import type { CanonicalBatchItem, ParsedCollectionSource } from './types'
import { dedupeAndCapItems } from './dedupe'

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  // 规避 EU consent 跳转墙
  Cookie: 'CONSENT=YES+cb; SOCS=CAI',
}

/** 混合电台/自动播放列表（无法完整离线枚举），显式拒绝并给出可操作提示 */
const MIX_LIST_PREFIXES = ['RD', 'UL', 'OL', 'LM']

export function extractYoutubePlaylistId(rawUrl: string): string | undefined {
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
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') {
    return undefined
  }
  const listId = url.searchParams.get('list')
  if (!listId || !/^[\w-]+$/.test(listId)) {
    return undefined
  }
  if (MIX_LIST_PREFIXES.some((prefix) => listId.startsWith(prefix))) {
    throw new BatchError(
      'UNSUPPORTED_URL',
      `混合/电台播放列表（${listId}）无法完整导入，请使用普通播放列表（ID 一般以 PL/UU/FL 开头）`,
    )
  }
  return listId
}

/** 从 HTML 中提取 `ytInitialData = {...}` 的 JSON（括号配平，容忍前缀变化） */
export function extractYtInitialData(html: string): Record<string, unknown> | undefined {
  const marker = 'ytInitialData'
  let searchFrom = 0
  while (true) {
    const markerIndex = html.indexOf(marker, searchFrom)
    if (markerIndex < 0) {
      return undefined
    }
    const start = html.indexOf('{', markerIndex + marker.length)
    if (start < 0) {
      return undefined
    }
    const json = sliceBalancedJson(html, start)
    searchFrom = start + 1
    if (json) {
      return json
    }
  }
}

function sliceBalancedJson(html: string, start: number): Record<string, unknown> | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1)) as Record<string, unknown>
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/** DFS 收集指定 renderer 键的节点，保持页面出现顺序 */
function collectRenderers(node: unknown, key: string, out: Array<Record<string, unknown>>): void {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectRenderers(child, key, out)
    }
    return
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === key && v && typeof v === 'object' && !Array.isArray(v)) {
        out.push(v as Record<string, unknown>)
      }
      collectRenderers(v, key, out)
    }
  }
}

function rendererTitle(renderer: Record<string, unknown>): string {
  const title = renderer.title as { simpleText?: string; runs?: Array<{ text?: string }> } | undefined
  return title?.simpleText ?? title?.runs?.map((run) => run.text ?? '').join('') ?? ''
}

function extractPageTitle(html: string): string | undefined {
  const match = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/)
  if (!match) {
    return undefined
  }
  return match[1]
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

export async function parseYoutubePlaylist(listId: string): Promise<ParsedCollectionSource> {
  let html: string
  try {
    const response = await fetch(`https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}&hl=en`, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
    })
    if (!response.ok) {
      throw new BatchError('PARSE_FAILED', `YouTube 播放列表页面返回 ${response.status}，请确认播放列表存在且为公开`)
    }
    html = await response.text()
  } catch (error) {
    if (error instanceof BatchError) {
      throw error
    }
    throw new BatchError('PARSE_FAILED', `YouTube 播放列表页面拉取失败：${(error as Error).message}`)
  }

  const data = extractYtInitialData(html)
  if (!data) {
    throw new BatchError(
      'PARSE_FAILED',
      '未能从页面解析出播放列表数据，请确认链接为 youtube.com/playlist?list=… 形式的公开播放列表',
    )
  }

  const renderers: Array<Record<string, unknown>> = []
  collectRenderers(data, 'playlistVideoRenderer', renderers)
  if (!renderers.length) {
    collectRenderers(data, 'videoRenderer', renderers)
  }

  const items: CanonicalBatchItem[] = []
  const pushItem = (videoId: string, title: string) => {
    items.push({
      sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
      service: 'youtube',
      dedupeKey: buildYoutubeSourceRef(videoId),
      title,
    })
  }
  for (const renderer of renderers) {
    const videoId = typeof renderer.videoId === 'string' ? renderer.videoId : undefined
    if (!videoId) {
      // 私密/不可播放条目没有 videoId，跳过
      continue
    }
    pushItem(videoId, rendererTitle(renderer))
  }
  if (!items.length) {
    // 新版播放列表页（2024+）用 lockupViewModel 承载条目
    const lockups: Array<Record<string, unknown>> = []
    collectRenderers(data, 'lockupViewModel', lockups)
    for (const lockup of lockups) {
      if (lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') {
        continue
      }
      const videoId =
        typeof lockup.contentId === 'string' && /^[\w-]+$/.test(lockup.contentId) ? lockup.contentId : undefined
      if (!videoId) {
        continue
      }
      const metadata = lockup.metadata as { lockupMetadataViewModel?: { title?: { content?: string } } } | undefined
      pushItem(videoId, metadata?.lockupMetadataViewModel?.title?.content ?? '')
    }
  }
  if (!items.length) {
    throw new BatchError('PARSE_FAILED', '播放列表中没有可导入的视频（列表为空或视频全部不可见）')
  }

  const { items: deduped, duplicates } = dedupeAndCapItems(items)
  if (duplicates > 0) {
    console.info(`[batch] youtube playlist ${listId}: skipped ${duplicates} duplicate/overflow items`)
  }

  return {
    kind: 'youtube_playlist',
    service: 'youtube',
    externalId: listId,
    title: extractPageTitle(html) ?? `播放列表 ${listId}`,
    items: deduped,
  }
}
