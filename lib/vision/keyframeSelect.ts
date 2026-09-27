// 纯函数关键帧选择：同一输入（场景时间 + 配置）永远得到同一帧集合。
// ffmpeg 负责产出候选场景时间，这里做去重、限距、限量、稳定 ID。
import { createHash } from 'crypto'

import { stableStringify } from '~/lib/history/hash'

export interface SelectKeyframesInput {
  /** ffmpeg 检测到的场景切换候选时间（秒，乱序可） */
  sceneTimes: number[]
  /** 媒体时长（秒）；null 时仅按场景候选选择 */
  duration: number | null
  maxFrames: number
  minGapSeconds: number
}

export interface SelectedKeyframe {
  id: string
  idx: number
  time: number
}

/** 时间统一到毫秒粒度，消除 ffmpeg 输出浮点尾差带来的不稳定 */
export function normalizeTime(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

export function computeKeyframeSetId(input: {
  sourceRef: string
  threshold: number
  maxFrames: number
  minGapSeconds: number
  duration: number | null
}): string {
  const digest = createHash('sha1')
    .update(
      stableStringify({
        sourceRef: input.sourceRef,
        threshold: input.threshold,
        maxFrames: input.maxFrames,
        minGapSeconds: input.minGapSeconds,
        duration: input.duration,
      }),
    )
    .digest('hex')
  return `kfset_${digest.slice(0, 12)}`
}

export function computeFrameId(setId: string, time: number): string {
  const digest = createHash('sha1')
    .update(`${setId}|${normalizeTime(time)}`)
    .digest('hex')
  return `kf_${digest.slice(0, 12)}`
}

/**
 * 确定性选择：
 * 1. 候选 = {0} ∪ sceneTimes，规范化到毫秒、升序、去重；
 * 2. 过滤越界（duration 已知时 t 必须落在 [0, duration]）；
 * 3. 贪心保序：与上一个已选帧间隔 < minGapSeconds 的候选丢弃；
 * 4. 超出 maxFrames 时截断（保最早）。返回选中的时间（秒，升序）。
 */
export function selectKeyframeTimes(input: SelectKeyframesInput): number[] {
  const maxFrames = Math.max(1, Math.floor(input.maxFrames))
  const minGapMs = Math.max(0, input.minGapSeconds) * 1000

  const candidates = new Set<number>([0])
  for (const time of input.sceneTimes) {
    if (Number.isFinite(time)) {
      candidates.add(Math.round(time * 1000))
    }
  }

  const durationMs =
    input.duration !== null && Number.isFinite(input.duration) ? Math.round(input.duration * 1000) : null
  const sorted = Array.from(candidates)
    .filter((timeMs) => timeMs >= 0 && (durationMs === null || timeMs <= durationMs))
    .sort((a, b) => a - b)

  const picked: number[] = []
  for (const timeMs of sorted) {
    if (picked.length >= maxFrames) {
      break
    }
    const last = picked[picked.length - 1]
    if (last !== undefined && timeMs - last < minGapMs) {
      continue
    }
    picked.push(timeMs)
  }
  return picked.map((timeMs) => timeMs / 1000)
}

/** 选择并生成稳定 frame id（id 依赖 setId） */
export function selectKeyframes(input: SelectKeyframesInput, setId: string): SelectedKeyframe[] {
  return selectKeyframeTimes(input).map((time, idx) => ({
    id: computeFrameId(setId, time),
    idx,
    time,
  }))
}
