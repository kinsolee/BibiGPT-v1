import { buildBilibiliSourceRef } from '../sourceRef'
import { SourceError } from '../types'
import type { BilibiliMediaDocument, SourceAdapter, TranscriptSegment } from '../types'
import { fetchBilibiliSourceInfo } from '../../bilibili/fetchBilibiliSubtitleUrls'

export function isBilibiliHost(hostname: string): boolean {
  return hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')
}

/** 支持 /video/BV… 与 /video/av…，返回 videoId 与分 P 号（1 起始） */
export function parseBilibiliVideoId(url: URL): { videoId: string; pageNumber?: string } | undefined {
  const matched = url.pathname.match(/\/video\/(BV[\w]+|bv[\w]+|av\d+)/)
  if (!matched) {
    return undefined
  }
  return { videoId: matched[1], pageNumber: url.searchParams.get('p') || undefined }
}

export const bilibiliAdapter: SourceAdapter = {
  id: 'bilibili',
  match(url: URL): boolean {
    return url.protocol === 'https:' && isBilibiliHost(url.hostname) && url.pathname.startsWith('/video/')
  },
  async fetch(rawUrl: string): Promise<BilibiliMediaDocument> {
    const url = new URL(rawUrl)
    const parsed = parseBilibiliVideoId(url)
    if (!parsed) {
      throw new SourceError('SOURCE_UNAVAILABLE', `无法从 URL 解析 bilibili videoId: ${rawUrl}`)
    }
    const { videoId, pageNumber } = parsed
    const sourceUrl = `https://www.bilibili.com/video/${videoId}${pageNumber ? `?p=${pageNumber}` : ''}`

    const info = await fetchBilibiliSourceInfo(videoId, pageNumber)
    const subtitleList = info.subtitle?.list ?? []
    const descriptionText = info.desc || info.dynamic ? `${info.desc ?? ''} ${info.dynamic ?? ''}`.trim() : undefined

    const buildDocument = (fields: {
      transcript: TranscriptSegment[]
      language?: string
      descriptionText?: string
    }): BilibiliMediaDocument => ({
      sourceRef: buildBilibiliSourceRef(videoId, pageNumber),
      sourceUrl,
      service: 'bilibili',
      title: info.title || videoId,
      duration: info.duration,
      images: info.pic ? [{ url: info.pic, alt: info.title }] : undefined,
      ...fields,
    })

    if (!subtitleList.length) {
      // 旧链路行为：无字幕但有简介时降级用简介生成摘要，不报错
      if (descriptionText) {
        return buildDocument({ transcript: [], descriptionText })
      }
      const hint = process.env.BILIBILI_SESSION_TOKEN ? '' : '（未配置 BILIBILI_SESSION_TOKEN，登录态字幕可能拿不到）'
      throw new SourceError('NO_TRANSCRIPT', `bilibili 视频没有可用字幕: ${videoId} ${hint}`)
    }

    const better = subtitleList.find(({ lan }: { lan: string }) => lan === 'zh-CN') || subtitleList[0]
    const subtitleUrl = better?.subtitle_url?.startsWith('//') ? `https:${better?.subtitle_url}` : better?.subtitle_url

    let response: Response
    try {
      response = await fetch(subtitleUrl)
    } catch (error) {
      throw new SourceError('SOURCE_UNAVAILABLE', `bilibili 字幕下载失败: ${videoId}`)
    }
    if (!response.ok) {
      if (response.status === 429) {
        throw new SourceError('RATE_LIMITED', `bilibili 字幕下载限流 (429): ${videoId}`)
      }
      throw new SourceError('SOURCE_UNAVAILABLE', `bilibili 字幕下载返回 ${response.status}: ${videoId}`)
    }

    let json: { body?: Array<{ from?: number; content?: string }> }
    try {
      json = await response.json()
    } catch {
      throw new SourceError('SOURCE_UNAVAILABLE', `bilibili 字幕内容无法解析: ${videoId}`)
    }
    const body = Array.isArray(json?.body) ? json.body : []
    if (!body.length) {
      if (descriptionText) {
        return buildDocument({ transcript: [], descriptionText })
      }
      throw new SourceError('NO_TRANSCRIPT', `bilibili 字幕内容为空: ${videoId}`)
    }

    const transcript: TranscriptSegment[] = body.map((item, index) => {
      const start = Number(item.from) || 0
      const next = Number(body[index + 1]?.from)
      return {
        start,
        end: index + 1 < body.length && Number.isFinite(next) ? next : start,
        text: item.content || '',
        lang: better.lan,
      }
    })
    transcript[0].sourceRef = subtitleUrl

    const document = buildDocument({ transcript, language: better.lan, descriptionText })

    // 多分 P 视频把每 P 映射成 chapter，起始时间为前面各 P duration 累加
    const pages = info.pages
    if (pages && pages.length > 1) {
      let cumulative = 0
      document.chapters = pages.map((page) => {
        const chapter = {
          title: page.part,
          start: cumulative,
          end: page.duration ? cumulative + page.duration : undefined,
          sourceRef: `bilibili:video:${videoId}:p${page.page}`,
        }
        cumulative += page.duration || 0
        return chapter
      })
    }
    return document
  },
}
