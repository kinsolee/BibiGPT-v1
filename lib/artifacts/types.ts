// KIN-42 章节/重点/关键词/大纲 artifacts 的前后端共享契约。
// 字段名与 KIN-41 的 lib/history/types.ts 表行保持可映射（chapters/highlights/artifacts）。

export type ArtifactChapterSource = 'platform' | 'generated'

export type ArtifactChapterItem = {
  idx: number
  title: string
  start: number | null
  end: number | null
  summary: string | null
  source: ArtifactChapterSource | null
  segmentIds: number[]
}

export type ArtifactHighlightItem = {
  idx: number
  text: string
  start: number | null
  end: number | null
  note: string | null
  segmentIds: number[]
}

export type ArtifactKeywordItem = {
  term: string
  segmentIds: number[]
}

export type ArtifactOutlineItem = {
  level: number
  title: string
  start: number | null
  end: number | null
  segmentIds: number[]
}

export type ArtifactTranscriptSegment = {
  idx: number
  start: number | null
  end: number | null
  text: string
  speaker: string | null
}

export type ArtifactBundle = {
  contentId: string
  summaryId: string | null
  chapterSource: ArtifactChapterSource | null
  /** 最新一次成功生成的 artifacts 创建时间（ISO）；无生成记录时为 null */
  generatedAt: string | null
  /** generate 接口：命中幂等（同输入已有同版本 artifacts）时为 true */
  reused?: boolean
  chapters: ArtifactChapterItem[]
  highlights: ArtifactHighlightItem[]
  keywords: ArtifactKeywordItem[]
  outline: ArtifactOutlineItem[]
  transcript: {
    id: string | null
    lang: string | null
    fullText: string | null
    segments: ArtifactTranscriptSegment[]
  } | null
  /** 有内容但拿不到字幕时的缺失原因，前端原样展示 */
  transcriptMissingReason: string | null
}

export type ArtifactBundleResponse = { found: false } | ({ found: true } & ArtifactBundle)
