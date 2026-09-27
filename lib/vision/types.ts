// KIN-48 视觉理解模块类型与 payload schema。
// canonical 数据写 KIN-41 artifacts 表：
//   kind='keyframes'        payload: KeyframeSetPayload   refs: KeyframeSetRefs
//   kind='frame_analysis'   payload: FrameAnalysisPayload refs: FrameAnalysisRefs
//   kind='image_note_images' payload: ImageNotePayload    refs: ImageNoteRefs（图文笔记图片缓存，来源失败时兜底展示）

export interface VisionFrame {
  /** 稳定 ID：kf_ + sha1(setId|timeMs) 前 12 位，重复生成不变 */
  id: string
  idx: number
  /** 秒（3 位小数，来自 ffmpeg pts_time） */
  time: number
  /** set 目录内的文件名（frame-000.jpg），展示 URL 由服务端拼装 */
  file: string
}

export interface KeyframeSetPayload {
  setId: string
  mode: 'video' | 'audio-only' | 'audio-illustrations'
  threshold: number
  source: { service: string; sourceRef: string; duration: number | null }
  frames: VisionFrame[]
  /** 场景切换候选总数（应用 minGap/cap 之前） */
  sceneCount: number
  /** 音频-only 插图（仅 mode=audio-illustrations） */
  illustrations: Array<{ id: string; url: string; alt?: string }>
  generatedAt: string
}

export type KeyframeSetRefs = {
  inputHash: string
  setId: string
  sourceRef: string
  threshold: number
}

export interface FrameAnalysisPayload {
  setId: string | null
  frameId: string
  idx: number | null
  /** 秒；插图类分析为 null */
  time: number | null
  ocr: string
  description: string
  tags: string[]
  model: string
  generatedAt: string
}

export type FrameAnalysisRefs = {
  inputHash: string
  setId: string | null
  frameId: string
  /** 帧图片内容 sha256，同内容不同 content 也能命中缓存 */
  frameHash: string
  model: string
}

export interface ImageNotePayload {
  sourceRef: string
  service: string
  title: string | null
  images: Array<{ url: string; alt?: string }>
  fetchedAt: string
}

export type ImageNoteRefs = {
  inputHash: string
  sourceRef: string
}

export type FrameAnalysisStatus = 'ok' | 'cached' | 'error'

export interface FrameAnalysisOutcome {
  frameId: string
  status: FrameAnalysisStatus
  error?: string
  analysis?: FrameAnalysisPayload
}
