import { getUserSubtitlePrompt, getUserSubtitleWithTimestampPrompt } from '~/lib/openai/prompt'
import { JobChunkSpec } from '~/lib/jobs/types'
import { VideoConfig } from '~/lib/types'
import { DEFAULT_LANGUAGE, LANGUAGE_CODE_TO_ENGLISH_NAME } from '~/utils/constants/language'

function formatSeconds(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return null
  }
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

function chunkRangeLabel(chunk: JobChunkSpec) {
  const start = formatSeconds(chunk.startSeconds)
  const end = formatSeconds(chunk.endSeconds)
  if (start && end) {
    return `${start}–${end}`
  }
  return start ?? ''
}

/**
 * chunk map 提示词：复用现有 subtitle prompt 模板保证输出风格一致，
 * 仅在标题上标注分段信息，让模型知道这是长视频的局部段落。
 */
export function buildChunkUserPrompt(input: {
  title: string | null
  chunk: JobChunkSpec
  totalChunks: number
  videoConfig: VideoConfig
  shouldShowTimestamp?: boolean
}) {
  const { title, chunk, totalChunks, videoConfig, shouldShowTimestamp } = input
  const range = chunkRangeLabel(chunk)
  const partLabel = range
    ? `（长视频第 ${chunk.index + 1}/${totalChunks} 部分，${range}）`
    : `（长视频第 ${chunk.index + 1}/${totalChunks} 部分）`
  const annotatedTitle = `${title ?? 'Untitled'} ${partLabel}`
  return shouldShowTimestamp
    ? getUserSubtitleWithTimestampPrompt(annotatedTitle, chunk.text, videoConfig)
    : getUserSubtitlePrompt(annotatedTitle, chunk.text, videoConfig)
}

/** 分层 reduce 的 section 时间区间：与 chunkOutputs 一一对应；中间层 section 的区间为其覆盖的原始 chunk 的并集 */
export interface SectionRange {
  startSeconds: number | null
  endSeconds: number | null
}

function formatRange(range: SectionRange) {
  const start = formatSeconds(range.startSeconds)
  const end = formatSeconds(range.endSeconds)
  if (start && end) {
    return `${start}–${end}`
  }
  return start ?? ''
}

/**
 * reduce 提示词：把按时间顺序的各段摘要合并成全局 summary + highlights + chapters。
 * 与 fast path 的输出模板保持同构（## Summary / ## Highlights），额外给出章节划分。
 * intermediate=true 为分层中间层：只做要点归并（无 chapters），供超长 transcript
 * 的多级 reduce 使用。
 * sectionRanges 优先提供每个 section 的真实时间区间（分层归并后的并集）；
 * 缺省时退回按 chunks[position] 推导（仅适用于 section 与 chunk 一一对应的最终层）。
 */
export function buildReduceUserPrompt(input: {
  title: string | null
  chunks: JobChunkSpec[]
  chunkOutputs: string[]
  videoConfig: VideoConfig
  shouldShowTimestamp?: boolean
  intermediate?: boolean
  sectionRanges?: SectionRange[]
}) {
  const { title, chunks, chunkOutputs, videoConfig, shouldShowTimestamp, intermediate, sectionRanges } = input
  const language = videoConfig.outputLanguage || DEFAULT_LANGUAGE
  const languageName = LANGUAGE_CODE_TO_ENGLISH_NAME[language] || language
  const sentenceCount = videoConfig.sentenceNumber || 7
  const emojiTemplateText = videoConfig.showEmoji ? '[Emoji] ' : ''
  const emojiDescriptionText = videoConfig.showEmoji ? 'Choose an appropriate emoji for each bullet point. ' : ''
  const wordsCount = videoConfig.detailLevel ? (Number(videoConfig.detailLevel) / 100) * 2 : 15

  const sections = chunkOutputs
    .map((output, position) => {
      // 分层 reduce 时优先用传入的真实区间（合并组的并集），避免按 chunks
      // 位置错位标注；最终层二者等价
      const provided = sectionRanges?.[position]
      const fallbackChunk = chunks[position]
      const range = provided ? formatRange(provided) : fallbackChunk ? chunkRangeLabel(fallbackChunk) : ''
      const header = range
        ? `Section ${position + 1}/${chunkOutputs.length} (${range}):`
        : `Section ${position + 1}/${chunkOutputs.length}:`
      return `${header}\n${output.trim()}`
    })
    .join('\n\n')

  const timestampRule = shouldShowTimestamp
    ? '- keep the start timestamp format `- seconds - ` in highlight bullets when the section summaries carry it\n'
    : ''

  const template = intermediate
    ? `Your output should use the following template:\n## Consolidated notes\n- ${emojiTemplateText}Bulletpoint\n\nYour task is to merge the given section summaries (parts of one long video) into a shorter consolidated list that keeps ALL distinct key points and their timestamps, drops duplicates and filler. Do not invent content.\n\nReply in ${languageName} Language.`
    : `Your output should use the following template:\n## Summary\n## Highlights\n- ${emojiTemplateText}Bulletpoint\n## Chapters\n- ${emojiTemplateText}mm:ss Chapter title\n\nYour task is to act as the final editor of a long-video summary pipeline. You are given the section-by-section summaries (in chronological order) of one long video. Merge them into one coherent summary of the WHOLE video:\n- "## Summary": one short paragraph summarizing the whole video\n- "## Highlights": up to ${sentenceCount} concise bullet points covering the most important content across ALL sections, each bullet point is at least ${wordsCount} words\n- "## Chapters": divide the whole video into 3-8 chapters by time range, one line each in the format "- mm:ss Chapter title — short description"\n\nRules:\n${timestampRule}- deduplicate repeated points across sections; do not invent content not present in the section summaries\n- there may be typos, please correct them\n\nReply in ${languageName} Language.`

  return `Title: "${(title ?? 'Untitled')
    .replace(/\n+/g, ' ')
    .trim()}"\nSection summaries:\n${sections}\n\nInstructions: ${template}`
}
