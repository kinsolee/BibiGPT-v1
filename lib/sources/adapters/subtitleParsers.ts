import { SourceError } from '../types'
import type { TranscriptSegment } from '../types'

/** `00:01:02,500` / `00:01:02.500` / `1:02.5` → 秒 */
export function parseSubtitleTimestamp(raw: string): number | undefined {
  const matched = raw.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/)
  if (!matched) {
    return undefined
  }
  const hours = Number(matched[1] ?? 0)
  const minutes = Number(matched[2])
  const seconds = Number(matched[3])
  const millis = Number(matched[4].padEnd(3, '0'))
  return hours * 3600 + minutes * 60 + seconds + millis / 1000
}

function buildSegments(cues: Array<{ start: string; end: string; text: string[] }>): TranscriptSegment[] {
  const segments: TranscriptSegment[] = []
  for (const cue of cues) {
    const start = parseSubtitleTimestamp(cue.start)
    const end = parseSubtitleTimestamp(cue.end)
    const text = cue.text.join(' ').trim()
    if (start === undefined || !text) {
      continue
    }
    segments.push({
      start,
      end: end !== undefined && end >= start ? end : start,
      text,
    })
  }
  return segments
}

/** SRT：序号行 + `start --> end` + 文本行 + 空行；WebVTT 复用同一路径 */
export function parseSrt(content: string): TranscriptSegment[] {
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const cues: Array<{ start: string; end: string; text: string[] }> = []
  let current: { start: string; end: string; text: string[] } | null = null

  for (const line of normalized.split('\n')) {
    const arrow = line.match(/^\s*(.+?)\s*-->\s*([0-9.,:]+)\s*.*$/)
    if (arrow) {
      if (current) {
        cues.push(current)
      }
      current = { start: arrow[1], end: arrow[2], text: [] }
      continue
    }
    if (!current) {
      continue
    }
    if (line.trim() === '') {
      cues.push(current)
      current = null
      continue
    }
    current.text.push(line.trim())
  }
  if (current) {
    cues.push(current)
  }
  return buildSegments(cues)
}

/** WebVTT：可带 WEBVTT 头/cue id/样式行，时间戳用 `.` 或 `,` */
export function parseVtt(content: string): TranscriptSegment[] {
  const body = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const withoutHeader = body.replace(/^WEBVTT[^\n]*\n/, '')
  const cleaned = withoutHeader
    .split('\n\n')
    .map((block) =>
      block
        .split('\n')
        .filter((line) => !/^(NOTE|STYLE|REGION)\b/.test(line.trim()))
        .join('\n'),
    )
    .join('\n\n')
  return parseSrt(cleaned)
}

/** ASS/SSA：取 [Events] 的 Dialogue 行，Format 决定字段顺序，Text 在最后 */
export function parseAss(content: string): TranscriptSegment[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  let section = ''
  let fields: string[] | null = null
  const cues: Array<{ start: string; end: string; text: string[] }> = []

  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[(.+)\]\s*$/)
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase()
      continue
    }
    if (section !== 'events') {
      continue
    }
    const formatMatch = line.match(/^\s*Format:\s*(.+)$/i)
    if (formatMatch) {
      fields = formatMatch[1].split(',').map((field) => field.trim().toLowerCase())
      continue
    }
    const dialogueMatch = line.match(/^\s*Dialogue:\s*(.+)$/i)
    if (!dialogueMatch) {
      continue
    }
    const resolvedFields = fields ?? [
      'layer',
      'start',
      'end',
      'style',
      'name',
      'marginl',
      'marginr',
      'marginv',
      'effect',
      'text',
    ]
    const parts = dialogueMatch[1].split(',')
    const startIndex = resolvedFields.indexOf('start')
    const endIndex = resolvedFields.indexOf('end')
    const textIndex = resolvedFields.indexOf('text')
    if (startIndex < 0 || endIndex < 0 || textIndex < 0) {
      continue
    }
    // Text 是最后一个字段，值可能自带逗号：剩余全部归 Text
    const text = parts
      .slice(textIndex)
      .join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\[Nn]/g, ' ')
      .trim()
    if (!text) {
      continue
    }
    cues.push({ start: parts[startIndex]?.trim() ?? '', end: parts[endIndex]?.trim() ?? '', text: [text] })
  }
  return buildSegments(cues)
}

const SUBTITLE_PARSERS: Record<string, (content: string) => TranscriptSegment[]> = {
  srt: parseSrt,
  vtt: parseVtt,
  ass: parseAss,
  ssa: parseAss,
}

export function subtitleExtensionOf(filename: string): string | undefined {
  const matched = filename.toLowerCase().match(/\.(srt|vtt|ass|ssa)$/)
  return matched?.[1]
}

export function parseSubtitleFile(filename: string, content: string): TranscriptSegment[] {
  const extension = subtitleExtensionOf(filename)
  const parser = extension ? SUBTITLE_PARSERS[extension] : undefined
  if (!parser) {
    throw new SourceError('SOURCE_UNAVAILABLE', `不支持的字幕格式: ${filename}（支持 srt/vtt/ass/ssa）`)
  }
  const segments = parser(content)
  if (!segments.length) {
    throw new SourceError('NO_TRANSCRIPT', `字幕文件没有可用内容: ${filename}`)
  }
  return segments
}
