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

function stableChunkHash(text: string) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 单条字幕超过 chunk 预算时按字符边界确定性硬切分（绝不丢弃内容）。
 * 按字符累积，超预算即封口；单个字符超预算（不可能出现）退化为整段输出。
 */
function splitOversizedItem(text: string, byteLimit: number): string[] {
  const pieces: string[] = []
  let current = ''
  let currentBytes = 0
  for (const char of text) {
    const charBytes = getUtf8ByteLength(char)
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
): TranscriptChunk[] {
  if (!Number.isFinite(byteLimit) || byteLimit <= 0) {
    throw new Error(`byteLimit must be a positive number, got ${byteLimit}`)
  }
  const sorted = items
    .slice()
    .sort((a, b) => a.index - b.index)
    .filter((item) => typeof item.text === 'string' && item.text.length > 0)
  if (sorted.length === 0) {
    return []
  }

  // 展开为不可再分的原子片段：普通 item 原样；超大 item 拆成多段
  const atoms: Array<{ text: string; itemIndex: number; seconds: number | null }> = []
  sorted.forEach((item) => {
    const text = item.text
    if (getUtf8ByteLength(text) <= byteLimit) {
      atoms.push({ text, itemIndex: item.index, seconds: toSeconds(item.s) })
      return
    }
    for (const piece of splitOversizedItem(text, byteLimit)) {
      atoms.push({ text: piece, itemIndex: item.index, seconds: toSeconds(item.s) })
    }
  })

  const chunks: TranscriptChunk[] = []
  let currentTexts: string[] = []
  let currentBytes = 0
  let firstAtomIndex = 0

  const flush = () => {
    if (currentTexts.length === 0) {
      return
    }
    const text = currentTexts.join(' ')
    const first = atoms[firstAtomIndex]
    const last = atoms[firstAtomIndex + currentTexts.length - 1]
    chunks.push({
      index: chunks.length,
      hash: stableChunkHash(text),
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
    const atomBytes = getUtf8ByteLength(atom.text)
    const separatorBytes = currentTexts.length > 0 ? 1 : 0
    if (currentBytes > 0 && currentBytes + separatorBytes + atomBytes > byteLimit) {
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
