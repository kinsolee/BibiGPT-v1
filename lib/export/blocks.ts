// KIN-47 中间块模型：ExportSpec → ExportBlock[]，Markdown/JSON/PDF/DOCX 四种渲染共用。
// 约束：timestamp 只出现在章节/重点/字幕段落里，绝不注入摘要正文（polished article）。

import type { ExportSpec } from './types'

export type ExportBlock =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullet'; text: string; indent: number }
  | { type: 'quote'; text: string }
  | { type: 'meta'; label: string; value: string }
  | { type: 'divider' }

/** 秒 → mm:ss / h:mm:ss */
export function formatTimestamp(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) {
    return null
  }
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function paragraphBlocks(text: string): ExportBlock[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map<ExportBlock>((part) => ({ type: 'paragraph', text: part }))
}

export function specToBlocks(spec: ExportSpec): ExportBlock[] {
  const blocks: ExportBlock[] = []

  blocks.push({ type: 'heading', level: 1, text: spec.title })
  if (spec.sourceUrl) {
    blocks.push({ type: 'meta', label: '来源', value: spec.sourceUrl })
  }
  if (spec.service) {
    blocks.push({ type: 'meta', label: '平台', value: spec.service })
  }
  if (spec.summaryMeta.createdAt) {
    blocks.push({ type: 'meta', label: '摘要时间', value: spec.summaryMeta.createdAt })
  }
  if (spec.summaryMeta.model) {
    blocks.push({ type: 'meta', label: '模型', value: spec.summaryMeta.model })
  }
  blocks.push({ type: 'divider' })

  if (spec.summary) {
    blocks.push({ type: 'heading', level: 2, text: '摘要' })
    blocks.push(...paragraphBlocks(spec.summary))
  }

  if (spec.chapters.length) {
    blocks.push({ type: 'heading', level: 2, text: '章节' })
    for (const chapter of spec.chapters) {
      const ts = formatTimestamp(chapter.start)
      const prefix = ts ? `【${ts}】` : ''
      const suffix = chapter.summary ? ` ${chapter.summary}` : ''
      blocks.push({ type: 'bullet', text: `${prefix}${chapter.title}${suffix}`, indent: 0 })
    }
  }

  if (spec.highlights.length) {
    blocks.push({ type: 'heading', level: 2, text: '重点' })
    for (const highlight of spec.highlights) {
      const ts = formatTimestamp(highlight.start)
      const prefix = ts ? `[${ts}] ` : ''
      blocks.push({ type: 'quote', text: `${prefix}${highlight.text}` })
      if (highlight.note) {
        blocks.push({ type: 'quote', text: `批注：${highlight.note}` })
      }
    }
  }

  if (spec.keywords.length) {
    blocks.push({ type: 'heading', level: 2, text: '关键词' })
    blocks.push({ type: 'paragraph', text: spec.keywords.map((k) => k.term).join(' · ') })
  }

  if (spec.outline.length) {
    blocks.push({ type: 'heading', level: 2, text: '大纲' })
    for (const item of spec.outline) {
      const ts = formatTimestamp(item.start)
      const prefix = ts ? `[${ts}] ` : ''
      blocks.push({ type: 'bullet', text: `${prefix}${item.title}`, indent: item.level === 2 ? 1 : 0 })
    }
  }

  if (spec.images.length) {
    blocks.push({ type: 'heading', level: 2, text: '图片' })
    for (const image of spec.images) {
      blocks.push({ type: 'bullet', text: image.alt ? `${image.alt} ${image.url}` : image.url, indent: 0 })
    }
  }

  if (spec.speakers.length) {
    blocks.push({ type: 'heading', level: 2, text: '说话人' })
    for (const speaker of spec.speakers) {
      blocks.push({ type: 'bullet', text: speaker.name, indent: 0 })
    }
  }

  if (spec.backlinks.length) {
    blocks.push({ type: 'heading', level: 2, text: '引用（backlinks）' })
    for (const backlink of spec.backlinks) {
      blocks.push({ type: 'bullet', text: `${backlink.title ?? backlink.contentId}`, indent: 0 })
    }
  }

  // 原文（transcript）与 polished article 严格分区，时间戳只允许出现在本节
  const transcript = spec.transcript
  const hasTranscript = Boolean(transcript && (transcript.segments.length || transcript.fullText))
  if (hasTranscript || spec.transcriptMissingReason) {
    blocks.push({ type: 'divider' })
    blocks.push({ type: 'heading', level: 2, text: '原文字幕' })
    if (transcript?.segments.length) {
      for (const segment of transcript.segments) {
        const ts = formatTimestamp(segment.start)
        const prefix = ts ? `[${ts}] ` : ''
        const speaker = segment.speaker ? `${segment.speaker}：` : ''
        blocks.push({ type: 'paragraph', text: `${prefix}${speaker}${segment.text}` })
      }
    } else if (transcript?.fullText) {
      blocks.push(...paragraphBlocks(transcript.fullText))
    } else if (spec.transcriptMissingReason) {
      blocks.push({ type: 'paragraph', text: spec.transcriptMissingReason })
    }
  }

  return blocks
}
