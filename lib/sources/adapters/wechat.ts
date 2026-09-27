import { SourceError } from '../types'
import type { SourceAdapter } from '../types'

/**
 * 微信图文/小绿书 adapter 骨架（自用版口径：不绕反爬）。
 * mp.weixin.qq.com 公众号图文与环境登录态相关；channels.weixin.qq.com
 * 为小绿书/视频号。两者缺失登录态时都返回可操作 AUTH_REQUIRED。
 */
export function isWechatHost(hostname: string): boolean {
  return hostname === 'mp.weixin.qq.com' || hostname === 'channels.weixin.qq.com'
}

export function parseWechatSource(url: URL): { contentId: string; kind: 'article' | 'channels' } | undefined {
  if (url.hostname === 'mp.weixin.qq.com') {
    // 公众号图文形态：/s?__biz=...&mid=...&idx=...&sn=... 或 /s/{hash}
    const biz = url.searchParams.get('__biz')
    if (url.pathname === '/s' && biz) {
      return {
        contentId: `${biz}_${url.searchParams.get('mid') ?? ''}_${url.searchParams.get('sn') ?? ''}`,
        kind: 'article',
      }
    }
    const hash = url.pathname.match(/^\/s\/([\w-]+)/)
    if (hash) {
      return { contentId: hash[1], kind: 'article' }
    }
    return undefined
  }
  // 小绿书/视频号：/profile/{id} 或图文直播回放形态
  const channels = url.pathname.match(/^\/(?:profile|live)\/([\w-]+)/)
  if (channels) {
    return { contentId: channels[1], kind: 'channels' }
  }
  return undefined
}

export const wechatAdapter: SourceAdapter = {
  id: 'wechat',
  match(url: URL): boolean {
    return url.protocol === 'https:' && isWechatHost(url.hostname) && Boolean(parseWechatSource(url))
  },
  async fetch(rawUrl: string): Promise<never> {
    const url = new URL(rawUrl)
    if (!parseWechatSource(url)) {
      throw new SourceError('SOURCE_UNAVAILABLE', `无法从 URL 解析微信图文/小绿书 ID: ${rawUrl}`)
    }
    if (!process.env.BIBI_WECHAT_COOKIE?.trim()) {
      throw new SourceError(
        'AUTH_REQUIRED',
        '微信图文/小绿书需要登录态或平台凭据（环境校验）：请在 .env 配置 BIBI_WECHAT_COOKIE 后重试；本任务不提供反爬绕过',
      )
    }
    throw new SourceError(
      'SOURCE_UNAVAILABLE',
      '微信 adapter 骨架未实现抓取逻辑（已识别 URL 与登录态配置），防止伪造内容',
    )
  },
}
