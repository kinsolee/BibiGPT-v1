import { SourceError } from '../types'
import type { SourceAdapter } from '../types'

/**
 * 抖音 adapter 骨架（自用版口径：不绕反爬）。
 * URL parser 完整（视频 /video/{id}、图文 /note/{id}、短链 v.douyin.com），
 * 抓取需要登录态：未配置 BIBI_DOUYIN_COOKIE → AUTH_REQUIRED，
 * 配置了也只提示未实现 —— 任何路径都不会产出伪造内容。
 */
export function isDouyinHost(hostname: string): boolean {
  return (
    hostname === 'douyin.com' ||
    hostname === 'iesdouyin.com' ||
    hostname.endsWith('.douyin.com') ||
    hostname.endsWith('.iesdouyin.com')
  )
}

export function parseDouyinSource(url: URL): { videoId: string; kind: 'video' | 'imageText' } | undefined {
  const matched = url.pathname.match(/^\/(?:video|note)\/(\d+)/)
  if (matched) {
    return { videoId: matched[1], kind: url.pathname.startsWith('/note/') ? 'imageText' : 'video' }
  }
  return undefined
}

function douyinError(hasCredential: boolean): SourceError {
  if (!hasCredential) {
    return new SourceError(
      'AUTH_REQUIRED',
      '抖音需要登录态才能读取内容：请在 .env 配置 BIBI_DOUYIN_COOKIE 后重试；本任务不提供反爬绕过',
    )
  }
  return new SourceError(
    'SOURCE_UNAVAILABLE',
    '抖音 adapter 骨架未实现抓取逻辑（已识别 URL 与登录态配置），防止伪造内容',
  )
}

export const douyinAdapter: SourceAdapter = {
  id: 'douyin',
  match(url: URL): boolean {
    return url.protocol === 'https:' && isDouyinHost(url.hostname) && Boolean(parseDouyinSource(url))
  },
  async fetch(rawUrl: string): Promise<never> {
    const url = new URL(rawUrl)
    if (!parseDouyinSource(url)) {
      throw new SourceError('SOURCE_UNAVAILABLE', `无法从 URL 解析抖音视频/图文 ID: ${rawUrl}`)
    }
    throw douyinError(Boolean(process.env.BIBI_DOUYIN_COOKIE?.trim()))
  },
}
