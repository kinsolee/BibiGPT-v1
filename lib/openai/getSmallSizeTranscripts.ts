// Copyright (c) 2022 Kazuki Nakayashiki.
// Modified work: Copyright (c) 2023 Qixiang Zhu.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

import { createHash } from 'crypto'

import { CommonSubtitleItem } from '~/lib/types'

// via https://github.com/lxfater/BilibiliSummary/blob/3d1a67cbe8e96adba60672b778ce89644a43280d/src/prompt.ts#L62
export function limitTranscriptByteLength(str: string, byteLimit: number = LIMIT_COUNT) {
  const utf8str = unescape(encodeURIComponent(str))
  const byteLength = utf8str.length
  if (byteLength > byteLimit) {
    const ratio = byteLimit / byteLength
    const newStr = str.substring(0, Math.floor(str.length * ratio))
    return newStr
  }
  return str
}

// Seems like 15,000 bytes is the limit for the prompt
// 13000 = 6500*2
const LIMIT_COUNT = 6200 // 2000 is a buffer

/**
 * 单个 chunk 的字节预算。必须低于 prompt.ts 里 limitTranscriptByteLength 的
 * 6200 上限，否则 chunk 文本会在拼 prompt 时被二次截断丢内容。
 */
export const DEFAULT_CHUNK_BYTE_LIMIT = 6000
/**
 * timestamp 模式预算：getUserSubtitleWithTimestampPrompt 会对 chunk 文本整体
 * JSON.stringify（ASCII 引号/反斜杠逐字符翻倍）后再过 6200 限幅。该模式下
 * 装箱按「编码后字节」计权，保证最坏转义情况下序列化结果仍不触发二次截断
 * （留 200 bytes 裕量覆盖外层引号与分隔符近似误差）。
 */
export const TIMESTAMP_CHUNK_BYTE_LIMIT = 6000

export interface ChunkOptions {
  /** true 时装箱与硬切分均按 JSON.stringify 后的字节数计权（timestamp prompt 场景） */
  encodedWeight?: boolean
}

function encodedByteLength(text: string) {
  return getUtf8ByteLength(JSON.stringify(text))
}

export interface TranscriptChunk {
  index: number
  /** chunk 正文（排序后 items 依 index 拼接）的 sha256 前 16 位，跨重启稳定 */
  hash: string
  text: string
  byteLength: number
  startSeconds: number | null
  endSeconds: number | null
  /** 覆盖排序后 subtitle items 的 [first, last] 闭区间下标 */
  firstItemIndex: number
  lastItemIndex: number
}

export function getUtf8ByteLength(text: string) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * chunk 身份哈希：文本 + 起止秒。时间轴会进入 chunk prompt（分段标注），
 * 字幕 timing 修正后必须产生新 chunk/job，避免复用旧结果返回过期时间戳。
 */
function stableChunkHash(text: string, startSeconds: number | null, endSeconds: number | null) {
  return createHash('sha256')
    .update(JSON.stringify({ text, startSeconds, endSeconds }), 'utf8')
    .digest('hex')
    .slice(0, 16)
}

/**
 * 单条字幕超过 chunk 预算时按字符边界确定性硬切分（绝不丢弃内容）。
 * 按字符累积，超预算即封口；单个字符超预算（不可能出现）退化为整段输出。
 */
function splitOversizedItem(text: string, byteLimit: number, weightOf: (text: string) => number): string[] {
  const pieces: string[] = []
  let current = ''
  let currentBytes = 0
  for (const char of text) {
    const charBytes = weightOf(char)
    if (currentBytes > 0 && currentBytes + charBytes > byteLimit) {
      pieces.push(current)
      current = char
      currentBytes = charBytes
    } else {
      current += char
      currentBytes += charBytes
    }
  }
  if (current) {
    pieces.push(current)
  }
  return pieces
}

function toSeconds(value: number | string | undefined): number | null {
  if (value === undefined || value === null || value === '') {
    return null
  }
  const seconds = Number(value)
  return Number.isFinite(seconds) ? seconds : null
}

/**
 * 确定性 transcript 切分：按字节预算贪心装箱，固定 chunk hash。
 * - items 先按 index 排序、剔除空文本；文本以 ' ' 连接（与旧 join 行为一致）。
 * - 不再随机丢弃：超预算一律切成多个 chunk，全部内容进入后续 map-reduce。
 * - 超大单条按字符边界硬切，切分结果只依赖文本本身，可重复。
 */
export function chunkSubtitles(
  items: Array<Pick<CommonSubtitleItem, 'text' | 'index' | 's'>>,
  byteLimit: number = DEFAULT_CHUNK_BYTE_LIMIT,
  options: ChunkOptions = {},
): TranscriptChunk[] {
  if (!Number.isFinite(byteLimit) || byteLimit <= 0) {
    throw new Error(`byteLimit must be a positive number, got ${byteLimit}`)
  }
  const weightOf = options.encodedWeight ? encodedByteLength : getUtf8ByteLength
  const sorted = items
    .slice()
    .sort((a, b) => a.index - b.index)
    .filter((item) => typeof item.text === 'string' && item.text.length > 0)
  if (sorted.length === 0) {
    return []
  }

  // 展开为不可再分的原子片段：普通 item 原样；超大 item 拆成多段。
  // spaced 表示该 atom 与前一个 atom 之间是否有 ' ' 分隔——同 item 硬切出的
  // 相邻 piece 之间不能插入空格，否则原始内容被污染
  const atoms: Array<{ text: string; itemIndex: number; seconds: number | null; spaced: boolean }> = []
  sorted.forEach((item) => {
    const text = item.text
    if (weightOf(text) <= byteLimit) {
      atoms.push({ text, itemIndex: item.index, seconds: toSeconds(item.s), spaced: true })
      return
    }
    const pieces = splitOversizedItem(text, byteLimit, weightOf)
    pieces.forEach((piece, pieceIndex) => {
      // 同 item 硬切出的后续 piece 与前一 piece 无分隔；新 item 的首 piece 才有 ' '
      atoms.push({ text: piece, itemIndex: item.index, seconds: toSeconds(item.s), spaced: pieceIndex === 0 })
    })
  })

  const chunks: TranscriptChunk[] = []
  let currentTexts: string[] = []
  let currentBytes = 0
  let firstAtomIndex = 0

  const flush = () => {
    if (currentTexts.length === 0) {
      return
    }
    const slice = atoms.slice(firstAtomIndex, firstAtomIndex + currentTexts.length)
    const text = slice.reduce(
      (acc, atom, position) => (position === 0 || !atom.spaced ? `${acc}${atom.text}` : `${acc} ${atom.text}`),
      '',
    )
    const first = slice[0]
    const last = slice[slice.length - 1]
    chunks.push({
      index: chunks.length,
      hash: stableChunkHash(text, first.seconds, last.seconds),
      text,
      byteLength: getUtf8ByteLength(text),
      startSeconds: first.seconds,
      endSeconds: last.seconds,
      firstItemIndex: first.itemIndex,
      lastItemIndex: last.itemIndex,
    })
    firstAtomIndex += currentTexts.length
    currentTexts = []
    currentBytes = 0
  }

  for (const atom of atoms) {
    const atomBytes = weightOf(atom.text)
    const separatorBytes = currentTexts.length > 0 && atom.spaced ? 1 : 0
    if (currentTexts.length > 0 && currentBytes + separatorBytes + atomBytes > byteLimit) {
      flush()
      currentTexts.push(atom.text)
      currentBytes = atomBytes
    } else {
      currentTexts.push(atom.text)
      currentBytes += separatorBytes + atomBytes
    }
  }
  flush()

  return chunks
}
