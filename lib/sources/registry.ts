import { bilibiliAdapter, parseBilibiliVideoId } from './adapters/bilibili'
import { parseYoutubeVideoId, youtubeAdapter } from './adapters/youtube'
import type { SourceAdapter } from './types'

export const sourceAdapters: SourceAdapter[] = [youtubeAdapter, bilibiliAdapter]

export function findSourceAdapter(rawUrl: string): SourceAdapter | undefined {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined
  }
  return sourceAdapters.find((adapter) => adapter.match(url))
}

export interface ParsedVideoSource {
  adapter: SourceAdapter
  url: URL
  videoId: string
  pageNumber?: string
}

/**
 * 白名单 URL parser：只接受 youtube/bilibili 支持域名下的视频 URL，
 * 拒绝其它任意域名（含 SSRF 常见目标）与非 http(s) 协议。
 */
export function parseVideoSourceUrl(rawUrl: string): ParsedVideoSource | undefined {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return undefined
  }

  for (const adapter of sourceAdapters) {
    if (!adapter.match(url)) {
      continue
    }
    if (adapter.id === 'youtube') {
      const videoId = parseYoutubeVideoId(url)
      if (videoId) {
        return { adapter, url, videoId }
      }
      return undefined
    }
    if (adapter.id === 'bilibili') {
      const parsed = parseBilibiliVideoId(url)
      if (parsed) {
        return { adapter, url, videoId: parsed.videoId, pageNumber: parsed.pageNumber }
      }
      return undefined
    }
  }
  return undefined
}
