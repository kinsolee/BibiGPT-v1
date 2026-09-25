import type { CommonSubtitleItem } from '~/lib/types'
import type { TranscriptSegment } from './types'

/**
 * TranscriptSegment[] → 旧链路 CommonSubtitleItem[]。
 * 分组算法与 utils/reduceSubtitleTimestamp 完全一致（每 7 条合一组、
 * s 取组首条 start、时间戳前缀 `${start} - `），保证旧输入摘要不回退。
 */
export function transcriptToSubtitleItems(
  transcript: Array<TranscriptSegment>,
  shouldShowTimestamp?: boolean,
): Array<CommonSubtitleItem> {
  const MINIMUM_COUNT_ONE_GROUP = 7

  return transcript.reduce((accumulator: CommonSubtitleItem[], current: TranscriptSegment, index: number) => {
    const groupIndex: number = Math.floor(index / MINIMUM_COUNT_ONE_GROUP)

    if (!accumulator[groupIndex]) {
      accumulator[groupIndex] = {
        index: groupIndex,
        s: current.start,
        text: shouldShowTimestamp ? current.start + ' - ' : '',
      }
    }

    accumulator[groupIndex].text = accumulator[groupIndex].text + current.text + ' '
    return accumulator
  }, [])
}

/** 无时间戳场景：每条 segment 一项（对应旧 savesubs txt 按 \r\n\r\n 切块的输出形态） */
export function transcriptToPlainTextItems(transcript: Array<TranscriptSegment>): Array<CommonSubtitleItem> {
  return transcript.map((segment, index) => ({ text: segment.text, index }))
}
