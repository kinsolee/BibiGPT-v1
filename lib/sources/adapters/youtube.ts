import { buildYoutubeSourceRef } from '../sourceRef'
import { SourceError } from '../types'
import type { MediaDocument, SourceAdapter, TranscriptSegment } from '../types'
import { fetchYoutubeSourceInfo, SUBTITLE_DOWNLOADER_URL } from '../../youtube/fetchYoutubeSubtitleUrls'
import type { YoutubeSubtitleFormat } from '../../youtube/fetchYoutubeSubtitleUrls'

export interface YoutubeSourceMeta {
  title?: string
  /** 秒 */
  duration?: number
  thumbnail?: string
}

export interface YoutubeTranscriptResult {
  transcript: TranscriptSegment[]
  language?: string
  /** 字幕 provider 记录，可回指来源 */
  providerRef?: string
  meta?: YoutubeSourceMeta
}

/**
 * YouTube 字幕 provider 接口：官方 transcript / yt-dlp / ASR 由后续任务补充实现。
 * 依次尝试，null 表示该 provider 拿不到字幕；全部失败才判定 NO_TRANSCRIPT，绝不伪造 transcript。
 */
export interface YoutubeTranscriptProvider {
  id: string
  fetchTranscript(videoId: string): Promise<YoutubeTranscriptResult | null>
}

function formatQualityToLang(quality: string): string {
  if (quality === 'zh-CN' || quality.startsWith('中文')) {
    return 'zh-CN'
  }
  if (quality.startsWith('English')) {
    return 'en'
  }
  return quality
}

/** 语言优先级与旧链路一致：zh-CN > English > English (auto) > 第一个 */
export function pickYoutubeSubtitleFormat(formats: YoutubeSubtitleFormat[]): YoutubeSubtitleFormat {
  const byQuality = (quality: string) => formats.find((format) => format.quality === quality)
  return (
    byQuality('zh-CN') ||
    byQuality('English') ||
    formats.find((format) => format.quality.startsWith('English (auto')) ||
    formats[0]
  )
}

export const savesubsProvider: YoutubeTranscriptProvider = {
  id: 'savesubs',
  async fetchTranscript(videoId) {
    const { title, duration, thumbnail, formats } = await fetchYoutubeSourceInfo(videoId)
    if (!formats.length) {
      return null
    }
    const chosen = pickYoutubeSubtitleFormat(formats)
    const subtitleUrl = `${SUBTITLE_DOWNLOADER_URL}${chosen.url}?ext=json`
    let response: Response
    try {
      response = await fetch(subtitleUrl)
    } catch (error) {
      throw new SourceError('SOURCE_UNAVAILABLE', `savesubs.com 字幕下载失败: ${videoId}`)
    }
    if (!response.ok) {
      if (response.status === 429) {
        throw new SourceError('RATE_LIMITED', `savesubs.com 字幕下载限流 (429): ${videoId}`)
      }
      throw new SourceError('SOURCE_UNAVAILABLE', `savesubs.com 字幕下载返回 ${response.status}: ${videoId}`)
    }

    let subtitles: Array<{ start?: number; lines?: string[] }>
    try {
      subtitles = await response.json()
    } catch {
      throw new SourceError('SOURCE_UNAVAILABLE', `savesubs.com 字幕内容无法解析: ${videoId}`)
    }
    if (!Array.isArray(subtitles) || subtitles.length === 0) {
      return null
    }

    const transcript: TranscriptSegment[] = subtitles.map((item, index) => {
      const start = Number(item.start) || 0
      const next = Number(subtitles[index + 1]?.start)
      return {
        start,
        end: index + 1 < subtitles.length && Number.isFinite(next) ? next : start,
        text: (item.lines || []).join(' '),
        lang: formatQualityToLang(chosen.quality),
      }
    })
    // 首段带上 provider 记录，便于回指字幕来源
    transcript[0].sourceRef = subtitleUrl
    return {
      transcript,
      language: formatQualityToLang(chosen.quality),
      providerRef: chosen.url,
      meta: { title, duration, thumbnail },
    }
  },
}

export const youtubeProviders: YoutubeTranscriptProvider[] = [savesubsProvider]

export function isYoutubeHost(hostname: string): boolean {
  return hostname === 'youtube.com' || hostname === 'youtu.be' || hostname.endsWith('.youtube.com')
}

/** 支持 watch / youtu.be / shorts / live / embed 形态 */
export function parseYoutubeVideoId(url: URL): string | undefined {
  if (url.hostname === 'youtu.be') {
    return url.pathname.split('/').filter(Boolean)[0] || undefined
  }
  const v = url.searchParams.get('v')
  if (v) {
    return v
  }
  const matched = url.pathname.match(/^\/(shorts|live|embed)\/([\w-]+)/)
  return matched?.[2]
}

export function createYoutubeAdapter(providers: YoutubeTranscriptProvider[] = youtubeProviders): SourceAdapter {
  return {
    id: 'youtube',
    match(url: URL): boolean {
      return url.protocol === 'https:' && isYoutubeHost(url.hostname)
    },
    async fetch(rawUrl: string): Promise<MediaDocument> {
      const url = new URL(rawUrl)
      const videoId = parseYoutubeVideoId(url)
      if (!videoId) {
        throw new SourceError('SOURCE_UNAVAILABLE', `无法从 URL 解析 YouTube videoId: ${rawUrl}`)
      }

      const errors: SourceError[] = []
      for (const provider of providers) {
        try {
          const result = await provider.fetchTranscript(videoId)
          if (!result) {
            continue
          }
          const meta = result.meta || {}
          return {
            sourceRef: buildYoutubeSourceRef(videoId),
            sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
            service: 'youtube',
            title: meta.title || videoId,
            duration: meta.duration,
            language: result.language,
            transcript: result.transcript,
            images: meta.thumbnail
              ? [{ url: meta.thumbnail.startsWith('//') ? `https:${meta.thumbnail}` : meta.thumbnail, alt: meta.title }]
              : undefined,
          }
        } catch (error) {
          if (error instanceof SourceError) {
            errors.push(error)
            continue
          }
          throw error
        }
      }
      if (errors.length) {
        throw errors[0]
      }
      throw new SourceError('NO_TRANSCRIPT', `YouTube 视频没有可用字幕: ${videoId}`)
    },
  }
}

export const youtubeAdapter: SourceAdapter = createYoutubeAdapter()
