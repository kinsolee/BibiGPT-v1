// KIN-48 vision env 配置读取；全部有缺省值，未配置也可用。
import { getDefaultModelId } from '~/lib/models/registry'

export const DEFAULT_SCENE_THRESHOLD = 0.3
export const DEFAULT_MAX_FRAMES = 24
export const DEFAULT_MIN_GAP_SECONDS = 2
export const DEFAULT_VISION_TIMEOUT_MS = 60_000

function readNumberEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(max, Math.max(min, parsed))
}

/** 场景切分阈值 0..1（ffmpeg select=gt(scene,T)），env BIBI_VISION_SCENE_THRESHOLD */
export function getSceneThreshold(): number {
  return readNumberEnv('BIBI_VISION_SCENE_THRESHOLD', DEFAULT_SCENE_THRESHOLD, 0, 1)
}

/** 单条视频最多保留关键帧数，env BIBI_VISION_MAX_FRAMES（1..120） */
export function getMaxFrames(): number {
  return readNumberEnv('BIBI_VISION_MAX_FRAMES', DEFAULT_MAX_FRAMES, 1, 120)
}

/** 相邻关键帧最小间隔秒，env BIBI_VISION_MIN_GAP_SECONDS（0..600） */
export function getMinGapSeconds(): number {
  return readNumberEnv('BIBI_VISION_MIN_GAP_SECONDS', DEFAULT_MIN_GAP_SECONDS, 0, 600)
}

/** 单帧 VLM 调用超时毫秒，env BIBI_VISION_TIMEOUT_MS（1000..600000） */
export function getVisionTimeoutMs(): number {
  return readNumberEnv('BIBI_VISION_TIMEOUT_MS', DEFAULT_VISION_TIMEOUT_MS, 1000, 600_000)
}

/** 批量分析的 VLM 并发数，env BIBI_VISION_ANALYZE_CONCURRENCY（1..8），缺省 3 */
export function getAnalyzeConcurrency(): number {
  return readNumberEnv('BIBI_VISION_ANALYZE_CONCURRENCY', 3, 1, 8)
}

/** 批量分析整体 deadline 毫秒（须小于 route maxDuration 300s），env BIBI_VISION_BATCH_DEADLINE_MS，缺省 240000 */
export function getBatchDeadlineMs(): number {
  return readNumberEnv('BIBI_VISION_BATCH_DEADLINE_MS', 240_000, 5000, 295_000)
}

/** VLM 模型；缺省回落既有 OpenAI 兼容默认模型 */
export function getVisionModel(): string {
  return process.env.BIBI_VISION_MODEL?.trim() || getDefaultModelId()
}

/** 音频-only 笔记插图开关（缺省关闭） */
export function isAudioIllustrationsEnabled(): boolean {
  return process.env.BIBI_VISION_AUDIO_ILLUSTRATIONS?.trim().toLowerCase() === 'true'
}
