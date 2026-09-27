// 时间戳标记解析/格式化与引用跳转链接（与服务端 resolveCitations、前端气泡共用）

const TIMESTAMP_TOKEN_PATTERN = /\[(\d{1,3}:[0-5]?\d(?::[0-5]?\d)?)\]/g

/** '83' | '1:23' | '1:02:03' → 秒 */
export function parseStampSeconds(stamp: string): number | null {
  const parts = stamp.split(':').map((part) => Number(part))
  if (parts.some((part) => !Number.isFinite(part))) {
    return null
  }
  if (parts.length === 1) {
    return parts[0]
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1]
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  }
  return null
}

/** 秒 → 'mm:ss'（超过 1 小时为 'h:mm:ss'），与字幕上下文行首格式一致 */
export function formatStamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (value: number) => value.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

export type StampToken = {
  token: string
  seconds: number
}

/** 提取正文中全部 [mm:ss]/[h:mm:ss] 标记（按出现顺序去重） */
export function extractStampTokens(text: string): StampToken[] {
  const seen = new Set<string>()
  const tokens: StampToken[] = []
  for (const match of Array.from(text.matchAll(TIMESTAMP_TOKEN_PATTERN))) {
    const stamp = match[1]
    if (seen.has(stamp)) {
      continue
    }
    const seconds = parseStampSeconds(stamp)
    if (seconds === null) {
      continue
    }
    seen.add(stamp)
    tokens.push({ token: match[0], seconds })
  }
  return tokens
}

/**
 * 与 components/Sentence.tsx 一致的跳转目标：点击引用在新标签页打开视频对应时间点。
 * bilibili: https://www.bilibili.com/video/{videoId}/?t={seconds}
 * youtube:  https://youtube.com/watch?v={videoId}&t={seconds}
 */
export function buildVideoTimestampUrl(videoId: string, service: string, seconds: number): string {
  const isBilibili = service === 'bilibili'
  return isBilibili
    ? `https://www.bilibili.com/video/${videoId}/?t=${Math.floor(seconds)}`
    : `https://youtube.com/watch?v=${videoId}&t=${Math.floor(seconds)}`
}
