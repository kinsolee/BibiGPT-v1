// vision 客户端 fetch 封装：纯浏览器侧，不 import 任何 server-only 模块
// （与 lib/artifacts/client.ts 同一分层理由：避免 node: 内建进客户端 bundle）。
import type { FrameAnalysisPayload, KeyframeSetPayload } from './types'

export class VisionApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'VisionApiError'
    this.status = status
    this.code = code
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null
    throw new VisionApiError(
      response.status,
      body?.error ?? 'request_failed',
      body?.message || `请求失败（${response.status}）`,
    )
  }
  return response.json() as Promise<T>
}

export interface VisionBundleResponse {
  found: boolean
  contentId: string
  payload: KeyframeSetPayload | null
  analyses: FrameAnalysisPayload[]
}

export function fetchVisionBundle(videoUrl: string): Promise<VisionBundleResponse> {
  return requestJson<VisionBundleResponse>(`/api/vision/keyframes?videoUrl=${encodeURIComponent(videoUrl)}`)
}

export interface GenerateKeyframesResponse {
  mode: KeyframeSetPayload['mode']
  payload: KeyframeSetPayload
  reused: boolean
  message?: string
}

export function generateKeyframes(videoUrl: string, options?: { force?: boolean }): Promise<GenerateKeyframesResponse> {
  return requestJson<GenerateKeyframesResponse>('/api/vision/keyframes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoUrl, force: options?.force ?? true }),
  })
}

export interface AnalyzeFramesResponse {
  results: Array<{ frameId: string; status: 'ok' | 'cached' | 'error'; error?: string }>
  okCount: number
  cachedCount: number
  errorCount: number
  analyses: FrameAnalysisPayload[]
}

export function analyzeFrames(
  videoUrl: string,
  options?: { frameId?: string; imageUrl?: string; imageId?: string; force?: boolean },
): Promise<AnalyzeFramesResponse> {
  return requestJson<AnalyzeFramesResponse>('/api/vision/frames/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoUrl,
      frameId: options?.frameId ?? null,
      imageUrl: options?.imageUrl ?? null,
      imageId: options?.imageId ?? null,
      force: options?.force ?? false,
    }),
  })
}

export function frameImageUrl(setId: string, file: string): string {
  return `/api/vision/frame?set=${encodeURIComponent(setId)}&name=${encodeURIComponent(file)}`
}

export interface ImagesResponse {
  status: 'live' | 'cache' | 'unavailable'
  contentId: string | null
  service: string | null
  sourceRef: string | null
  images: Array<{ url: string; alt?: string }>
  reason?: string
}

export function fetchImageNoteImages(videoUrl: string): Promise<ImagesResponse> {
  return requestJson<ImagesResponse>(`/api/vision/images?videoUrl=${encodeURIComponent(videoUrl)}`)
}
