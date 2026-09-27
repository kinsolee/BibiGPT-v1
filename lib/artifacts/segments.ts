import type { ArtifactTranscriptSegment } from './types'
import { formatSrtTimestamp, formatTimestamp } from './seekUrl'

export type SegmentIndexEntry = {
  idx: number
  start: number
  end: number
  text: string
}

/** 按 start 升序的轻量索引，供时间→segment 映射与 prompt 渲染使用 */
export class SegmentIndex {
  private readonly starts: number[]
  readonly entries: SegmentIndexEntry[]

  constructor(segments: Array<Pick<ArtifactTranscriptSegment, 'idx' | 'start' | 'end' | 'text'>>) {
    this.entries = segments
      .filter((segment) => segment.start !== null && Number.isFinite(segment.start))
      .map((segment) => ({
        idx: segment.idx,
        start: Number(segment.start),
        end: segment.end !== null && Number.isFinite(segment.end) ? Number(segment.end) : Number(segment.start),
        text: segment.text,
      }))
      .sort((a, b) => a.start - b.start)
    this.starts = this.entries.map((entry) => entry.start)
  }

  get size() {
    return this.entries.length
  }

  get lastEnd(): number | null {
    const last = this.entries[this.entries.length - 1]
    return last ? last.end : null
  }

  /** 第一个 start >= seconds 的 segment 下标 */
  private lowerBound(seconds: number): number {
    let lo = 0
    let hi = this.starts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.starts[mid] < seconds) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return lo
  }

  /** 覆盖 [start, end) 时间段的 segment idx 列表；区间无效时回退为包含 start 的 segment */
  segmentIdsForRange(start: number | null, end: number | null): number[] {
    if (start === null || !this.entries.length) {
      return []
    }
    let from = this.lowerBound(Math.max(0, start))
    if (from >= this.entries.length) {
      return [this.entries[this.entries.length - 1].idx]
    }
    // start 落在某个 segment 中间时取包含它的那一段
    if (this.starts[from] > start && from > 0) {
      from -= 1
    }
    let to = from
    if (end !== null) {
      // 左闭右开：恰好在 end 起播的 segment 属于下一章节
      to = this.lowerBound(end) - 1
      if (to < from) {
        to = from
      }
      if (to >= this.entries.length) {
        to = this.entries.length - 1
      }
    }
    return this.entries.slice(from, to + 1).map((entry) => entry.idx)
  }
}

/** 渲染给模型的时间轴文本，超长时均匀抽稀保持全程覆盖 */
export function renderSegmentsForPrompt(index: SegmentIndex, charBudget = 240_000): string {
  let lines = index.entries.map((entry) => `[${entry.idx}] ${formatTimestamp(entry.start)} ${entry.text}`)
  let total = lines.reduce((sum, line) => sum + line.length + 1, 0)
  if (total > charBudget && index.entries.length > 1) {
    const step = Math.ceil(index.entries.length / Math.max(1, Math.floor((index.entries.length * charBudget) / total)))
    const thinned = index.entries.filter((_, position) => position % step === 0)
    lines = thinned.map((entry) => `[${entry.idx}] ${formatTimestamp(entry.start)} ${entry.text}`)
    total = lines.reduce((sum, line) => sum + line.length + 1, 0)
    console.info(`[artifacts] transcript thinned for prompt: step=${step} chars=${total}`)
  }
  return lines.join('\n')
}

export function buildSrt(segments: ArtifactTranscriptSegment[]): string {
  return segments
    .map((segment, position) => {
      const start = segment.start ?? 0
      const end = segment.end !== null && segment.end > start ? segment.end : start + 2
      return `${position + 1}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${segment.text}\n`
    })
    .join('\n')
}

export function buildPlainTextTranscript(segments: ArtifactTranscriptSegment[]): string {
  return segments.map((segment) => `${formatTimestamp(segment.start)} ${segment.text}`).join('\n')
}
