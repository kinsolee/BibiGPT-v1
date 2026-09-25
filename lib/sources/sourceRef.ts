const YOUTUBE_REF = /^youtube:video:([\w-]+)$/
const BILIBILI_REF = /^bilibili:video:(av\d+|BV\w+|bv\w+)(?::p(\d+))?$/

export function buildYoutubeSourceRef(videoId: string): string {
  return `youtube:video:${videoId}`
}

export function buildBilibiliSourceRef(videoId: string, pageNumber?: null | string): string {
  const page = Number(pageNumber) > 1 ? `:p${Number(pageNumber)}` : ''
  return `bilibili:video:${videoId}${page}`
}

/** sourceRef 反解回原 URL，供历史记录/KIN-41 表回指 */
export function sourceRefToUrl(sourceRef: string): string | undefined {
  const youtube = sourceRef.match(YOUTUBE_REF)
  if (youtube) {
    return `https://www.youtube.com/watch?v=${youtube[1]}`
  }
  const bilibili = sourceRef.match(BILIBILI_REF)
  if (bilibili) {
    const page = bilibili[2] ? `?p=${bilibili[2]}` : ''
    return `https://www.bilibili.com/video/${bilibili[1]}${page}`
  }
  return undefined
}

export function parseSourceRef(
  sourceRef: string,
): { service: string; videoId: string; pageNumber?: number } | undefined {
  const youtube = sourceRef.match(YOUTUBE_REF)
  if (youtube) {
    return { service: 'youtube', videoId: youtube[1] }
  }
  const bilibili = sourceRef.match(BILIBILI_REF)
  if (bilibili) {
    return { service: 'bilibili', videoId: bilibili[1], pageNumber: bilibili[2] ? Number(bilibili[2]) : undefined }
  }
  return undefined
}
