// 站内统一的"跳转到视频某个时间点"逻辑：SummaryResult 的 Sentence 与
// KIN-42 的章节/重点/时间轴/字幕列表共用，保证 URL 口径一致。

export function isBilibiliUrl(videoUrl: string): boolean {
  return videoUrl.includes('bilibili.com')
}

export function buildSeekUrl(videoUrl: string, videoId: string, seconds: number | null): string | null {
  if (!videoId || seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return null
  }
  return isBilibiliUrl(videoUrl)
    ? `https://www.bilibili.com/video/${videoId}/?t=${Math.floor(seconds)}`
    : `https://youtube.com/watch?v=${videoId}&t=${Math.floor(seconds)}`
}

/** 1:23:45 / 23:45 形式的展示时间戳 */
export function formatTimestamp(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '--:--'
  }
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

/** SRT 字幕时间：00:00:01,000 */
export function formatSrtTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds * 1000))
  const ms = total % 1000
  const whole = Math.floor(total / 1000)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const pad = (value: number, width = 2) => String(value).padStart(width, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`
}
