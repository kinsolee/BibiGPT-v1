import { SourceError } from '../types'
import type { SourceAdapter } from '../types'

/** 快手 adapter 骨架（自用版口径：不绕反爬，登录态缺失返回可操作错误） */
export function isKuaishouHost(hostname: string): boolean {
  return hostname === 'kuaishou.com' || hostname.endsWith('.kuaishou.com')
}

export function parseKuaishouSource(url: URL): { videoId: string } | undefined {
  const matched = url.pathname.match(/^\/(?:short-video|fw\/photo|photo)\/([\w-]+)/)
  if (matched) {
    return { videoId: matched[1] }
  }
  // v.kuaishou.com 短链：路径即短码
  if (url.hostname === 'v.kuaishou.com') {
    const code = url.pathname.split('/').filter(Boolean)[0]
    if (code) {
      return { videoId: code }
    }
  }
  return undefined
}

export const kuaishouAdapter: SourceAdapter = {
  id: 'kuaishou',
  match(url: URL): boolean {
    return url.protocol === 'https:' && isKuaishouHost(url.hostname) && Boolean(parseKuaishouSource(url))
  },
  async fetch(rawUrl: string): Promise<never> {
    const url = new URL(rawUrl)
    if (!parseKuaishouSource(url)) {
      throw new SourceError('SOURCE_UNAVAILABLE', `无法从 URL 解析快手视频 ID: ${rawUrl}`)
    }
    if (!process.env.BIBI_KUAISHOU_COOKIE?.trim()) {
      throw new SourceError(
        'AUTH_REQUIRED',
        '快手需要登录态才能读取内容：请在 .env 配置 BIBI_KUAISHOU_COOKIE 后重试；本任务不提供反爬绕过',
      )
    }
    throw new SourceError(
      'SOURCE_UNAVAILABLE',
      '快手 adapter 骨架未实现抓取逻辑（已识别 URL 与登录态配置），防止伪造内容',
    )
  },
}
