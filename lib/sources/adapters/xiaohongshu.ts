import { SourceError } from '../types'
import type { SourceAdapter } from '../types'

/** 小红书图文/视频 adapter 骨架（自用版口径：不绕反爬，登录态缺失返回可操作错误） */
export function isXiaohongshuHost(hostname: string): boolean {
  return hostname === 'xiaohongshu.com' || hostname.endsWith('.xiaohongshu.com') || hostname === 'xhslink.com'
}

export function parseXiaohongshuSource(url: URL): { noteId: string; kind: 'note' } | undefined {
  const matched = url.pathname.match(/^\/(?:explore|discovery\/item)\/([\w-]+)/)
  if (matched) {
    return { noteId: matched[1], kind: 'note' }
  }
  // xhslink.com 短链：路径即短码
  if (url.hostname === 'xhslink.com') {
    const code = url.pathname.split('/').filter(Boolean)[0]
    if (code) {
      return { noteId: code, kind: 'note' }
    }
  }
  return undefined
}

export const xiaohongshuAdapter: SourceAdapter = {
  id: 'xiaohongshu',
  match(url: URL): boolean {
    return url.protocol === 'https:' && isXiaohongshuHost(url.hostname) && Boolean(parseXiaohongshuSource(url))
  },
  async fetch(rawUrl: string): Promise<never> {
    const url = new URL(rawUrl)
    if (!parseXiaohongshuSource(url)) {
      throw new SourceError('SOURCE_UNAVAILABLE', `无法从 URL 解析小红书笔记 ID: ${rawUrl}`)
    }
    if (!process.env.BIBI_XHS_COOKIE?.trim()) {
      throw new SourceError(
        'AUTH_REQUIRED',
        '小红书需要登录态才能读取笔记（图文 OCR/VLM 需登录可见）：请在 .env 配置 BIBI_XHS_COOKIE 后重试；本任务不提供反爬绕过',
      )
    }
    throw new SourceError(
      'SOURCE_UNAVAILABLE',
      '小红书 adapter 骨架未实现抓取逻辑（已识别 URL 与登录态配置），防止伪造内容',
    )
  },
}
