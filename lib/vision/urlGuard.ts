// 外链图片 URL 守卫（P1-1 SSRF 防御）。
// vision 服务端只 fetch 两类来源：本模块校验过的公网 http(s) 图片 URL，
// 以及磁盘上由 ffmpeg 产出的关键帧。可调用方永远不能直接传 URL 给 fetcher。
import { SourceError } from '~/lib/sources/types'

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** 私网/回环/链路本地段（含云 metadata 169.254.169.254）；IPv6 只拦明确本地段 */
const BLOCKED_HOST_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^localhost$/i, label: 'localhost' },
  { pattern: /\.local$/i, label: 'mDNS' },
  { pattern: /^127\./, label: 'loopback' },
  { pattern: /^0\.0\.0\.0$/, label: 'unspecified' },
  { pattern: /^10\./, label: 'private-10' },
  { pattern: /^192\.168\./, label: 'private-192' },
  { pattern: /^172\.(1[6-9]|2\d|3[01])\./, label: 'private-172' },
  { pattern: /^169\.254\./, label: 'link-local/metadata' },
  { pattern: /^\[?::1\]?$/, label: 'ipv6-loopback' },
  { pattern: /^\[?f[cd][0-9a-f]{2}:/i, label: 'ipv6-unique-local' },
  { pattern: /^\[?fe80:/i, label: 'ipv6-link-local' },
]

export function isSafePublicImageUrl(rawUrl: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return false
  }
  const hostname = url.hostname
  if (!hostname) {
    return false
  }
  const ipLike = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':')
  if (ipLike) {
    return !BLOCKED_HOST_PATTERNS.some(({ pattern }) => pattern.test(hostname))
  }
  // 域名主机：只拦明确本地标识；DNS 解析结果不做运行时校验（自用版口径，
  // 且 URL 只能来自服务端落库数据，不接受客户端直传）
  return !BLOCKED_HOST_PATTERNS.some(({ pattern }) => pattern.test(hostname))
}

export function assertSafePublicImageUrl(rawUrl: string): void {
  if (!isSafePublicImageUrl(rawUrl)) {
    throw new SourceError('SOURCE_UNAVAILABLE', `不安全或不受支持的图片 URL，已拒绝抓取: ${rawUrl.slice(0, 200)}`)
  }
}
