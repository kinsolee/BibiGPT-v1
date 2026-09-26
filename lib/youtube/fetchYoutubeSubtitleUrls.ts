import { SourceError } from '../sources/types'

export const SUBTITLE_DOWNLOADER_URL = 'https://savesubs.com'

export interface YoutubeSubtitleFormat {
  quality: string
  url: string
}

export interface YoutubeSourceInfo {
  title: string
  /** 秒 */
  duration?: number
  thumbnail?: string
  formats: YoutubeSubtitleFormat[]
}

export async function fetchYoutubeSourceInfo(videoId: string): Promise<YoutubeSourceInfo> {
  let response: Response
  try {
    response = await fetch(SUBTITLE_DOWNLOADER_URL + '/action/extract', {
      method: 'POST',
      body: JSON.stringify({
        data: { url: `https://www.youtube.com/watch?v=${videoId}` },
      }),
      headers: {
        'Content-Type': 'text/plain',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
        'X-Auth-Token': `${process.env.SAVESUBS_X_AUTH_TOKEN}` || '',
        'X-Requested-Domain': 'savesubs.com',
        'X-Requested-With': 'xmlhttprequest',
      },
    })
  } catch (error) {
    throw new SourceError('SOURCE_UNAVAILABLE', `savesubs.com 网络请求失败: ${videoId}`)
  }
  if (!response.ok) {
    if (response.status === 429) {
      throw new SourceError('RATE_LIMITED', `savesubs.com 限流 (429): ${videoId}`)
    }
    throw new SourceError('SOURCE_UNAVAILABLE', `savesubs.com 返回 ${response.status}: ${videoId}`)
  }

  let payload: any
  try {
    payload = await response.json()
  } catch {
    throw new SourceError('SOURCE_UNAVAILABLE', `savesubs.com 响应无法解析: ${videoId}`)
  }
  // 无有效 X-Auth-Token 时 savesubs 会返回 200 + {"status":false,"message":"BLOCKED"}
  if (payload?.status === false) {
    if (payload?.message === 'BLOCKED') {
      throw new SourceError(
        'AUTH_REQUIRED',
        `savesubs.com 拒绝了请求（BLOCKED），请配置有效的 SAVESUBS_X_AUTH_TOKEN: ${videoId}`,
      )
    }
    throw new SourceError('SOURCE_UNAVAILABLE', `savesubs.com 返回错误 ${payload?.message}: ${videoId}`)
  }
  const json = payload?.response || {}

  /*
   * "title": "Microsoft vs Google: AI War Explained | tech",
   * "duration": "13 minutes and 15 seconds",
   * "duration_raw": "795",
   * "uploader": "Joma Tech / 2023-02-20",
   * "thumbnail": "//i.ytimg.com/vi/BdHaeczStRA/mqdefault.jpg",
   * "formats": [{ "quality": "English (auto-generated)", "url": "/action/extract/..." }]
   */
  return {
    title: json.title,
    duration: Number(json.duration_raw) || undefined,
    thumbnail: typeof json.thumbnail === 'string' ? json.thumbnail : undefined,
    formats: Array.isArray(json.formats) ? json.formats : [],
  }
}
