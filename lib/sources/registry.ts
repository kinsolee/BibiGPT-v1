import { bilibiliAdapter, parseBilibiliVideoId } from './adapters/bilibili'
import { douyinAdapter } from './adapters/douyin'
import { kuaishouAdapter } from './adapters/kuaishou'
import { parseYoutubeVideoId, youtubeAdapter } from './adapters/youtube'
import { xiaohongshuAdapter } from './adapters/xiaohongshu'
import { wechatAdapter } from './adapters/wechat'
import type { SourceAdapter } from './types'

export const sourceAdapters: SourceAdapter[] = [youtubeAdapter, bilibiliAdapter]

/**
 * KIN-46 新来源（社媒骨架）白名单：纯 JS 实现，客户端可安全引用。
 * 本地文件/播客 RSS/无字幕 YouTube ASR 三个重型 adapter（依赖 fs/ffmpeg/
 * yt-dlp）在 server-only 的 lib/sources/adapters/extendedRegistry.ts 注册，
 * 避免静态进入客户端 bundle（webpack 禁 node: 内建模块）。
 * /api/sumup 旧主流程（fetchSubtitle → buildSourceUrl 只认 youtube/bilibili）
 * 与 sourceAdapters 均保持不变。
 */
export const extendedSourceAdapters: SourceAdapter[] = [
  douyinAdapter,
  kuaishouAdapter,
  xiaohongshuAdapter,
  wechatAdapter,
]

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
