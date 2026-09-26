import { find, sample } from '~/utils/fp'
import { SourceError } from '../sources/types'

type BilibiliSubtitles = {
  lan: string
  lan_doc?: string
  subtitle_url: string
}

interface BilibiliVideoPage {
  page: number
  part: string
  cid: number
  duration?: number
}

export interface BilibiliSourceInfo {
  title: string
  desc?: string
  dynamic?: string
  /** 秒 */
  duration?: number
  pic?: string
  aid?: number
  bvid?: string
  pages?: BilibiliVideoPage[]
  subtitle: { list: BilibiliSubtitles[] }
}

function toSourceError(videoId: string, code: number, message: string): SourceError {
  if (code === -412 || code === -111) {
    // -412: 请求被拦截（触发风控/验证码）；-111: 未登录或 SESSION 失效
    return new SourceError(
      'AUTH_REQUIRED',
      `bilibili ${videoId} 需要登录态（code ${code}: ${message}），请配置 BILIBILI_SESSION_TOKEN`,
    )
  }
  if (code === -404) {
    return new SourceError('SOURCE_UNAVAILABLE', `bilibili 视频不存在（code -404: ${message}）: ${videoId}`)
  }
  return new SourceError('SOURCE_UNAVAILABLE', `bilibili 接口异常（code ${code}: ${message}）: ${videoId}`)
}

async function getJson(requestUrl: string, commonConfig: RequestInit, videoId: string): Promise<any> {
  try {
    const response = await fetch(requestUrl, commonConfig)
    return await response.json()
  } catch (error) {
    throw new SourceError('SOURCE_UNAVAILABLE', `bilibili 网络请求失败: ${requestUrl}`)
  }
}

export const fetchBilibiliSourceInfo = async (
  videoId: string,
  pageNumber?: null | string,
): Promise<BilibiliSourceInfo> => {
  const sessdata = sample(process.env.BILIBILI_SESSION_TOKEN?.split(','))
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
    Host: 'api.bilibili.com',
    Cookie: `SESSDATA=${sessdata}`,
  }
  const commonConfig: RequestInit = {
    method: 'GET',
    cache: 'no-cache',
    headers,
    referrerPolicy: 'no-referrer',
  }

  const params = videoId.startsWith('av') ? `?aid=${videoId.slice(2)}` : `?bvid=${videoId}`
  const requestUrl = `https://api.bilibili.com/x/web-interface/view${params}`
  console.log(`fetch`, requestUrl)
  const json = await getJson(requestUrl, commonConfig, videoId)
  if (json?.code !== 0 || !json?.data) {
    throw toSourceError(videoId, json?.code ?? -1, json?.message || '未知错误')
  }

  // support multiple parts of video：与旧链路保持一致，存在 pages（含单 P）时走 player/v2 拿字幕列表
  if (pageNumber || json?.data?.pages?.length > 0) {
    const { aid, pages } = json?.data || {}
    const page = find(pages, { page: Number(pageNumber || 1) }) as BilibiliVideoPage | undefined
    if (!page?.cid) {
      throw new SourceError('SOURCE_UNAVAILABLE', `bilibili 分 P 不存在: ${videoId} p=${pageNumber || 1}`)
    }

    // https://api.bilibili.com/x/player/v2?aid=865462240&cid=1035524244
    const pageUrl = `https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${page.cid}`
    const j = await getJson(pageUrl, commonConfig, videoId)
    if (j?.code !== 0) {
      throw toSourceError(videoId, j?.code ?? -1, j?.message || '未知错误')
    }

    // r.data.subtitle.subtitles
    return { ...json.data, subtitle: { list: j.data.subtitle.subtitles } }
  }

  // { code: -404, message: '啥都木有', ttl: 1 }
  return json.data
}
