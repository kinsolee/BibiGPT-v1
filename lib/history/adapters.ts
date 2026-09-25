import { CommonSubtitleItem, VideoService } from '~/lib/types'
import { TranscriptSegment } from './types'

const TIMESTAMP_PREFIX = /^\s*\d+(\.\d+)?\s*-\s*/

export function commonSubtitlesToSegments(
  subtitles: Array<CommonSubtitleItem>,
  stripTimestampPrefix?: boolean,
): TranscriptSegment[] {
  const sorted = subtitles.slice().sort((a, b) => a.index - b.index)
  return sorted
    .map((item, index) => {
      const start = Number(item.s ?? 0)
      const next = sorted[index + 1]
      const end = next ? Number(next.s ?? start) : null
      const rawText = (item.text ?? '').trim()
      const text = stripTimestampPrefix ? rawText.replace(TIMESTAMP_PREFIX, '').trim() : rawText
      return { start, end, text }
    })
    .filter((segment) => segment.text.length > 0)
}

export function buildSourceUrl(videoId: string, service: string | undefined, pageNumber?: null | string) {
  if (service === VideoService.Youtube) {
    return `https://www.youtube.com/watch?v=${videoId}`
  }
  const url = `https://www.bilibili.com/video/${videoId}`
  return pageNumber ? `${url}?p=${pageNumber}` : url
}

/** 参与 summary input_hash 的配置快照：仅保留影响生成结果的选项，剔除 enableStream 等噪音 */
export function toSummaryConfigSnapshot(videoConfig: Record<string, unknown>): Record<string, unknown> {
  const keys = [
    'model',
    'showTimestamp',
    'showEmoji',
    'outputLanguage',
    'detailLevel',
    'sentenceNumber',
    'outlineLevel',
  ]
  const snapshot: Record<string, unknown> = {}
  for (const key of keys) {
    if (videoConfig[key] !== undefined) {
      snapshot[key] = videoConfig[key]
    }
  }
  return snapshot
}
