import type { ArtifactBundle, ArtifactBundleResponse } from './types'

export class ArtifactsApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ArtifactsApiError'
    this.status = status
    this.code = code
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null
    throw new ArtifactsApiError(
      response.status,
      body?.error ?? 'request_failed',
      body?.message || `请求失败（${response.status}）`,
    )
  }
  return response.json() as Promise<T>
}

/** 读取已落库的章节/重点/字幕 bundle；未生成过时返回 { found: false } */
export function fetchArtifactBundle(videoUrl: string, pageNumber?: string | null): Promise<ArtifactBundleResponse> {
  const params = new URLSearchParams({ videoUrl })
  if (pageNumber) {
    params.set('pageNumber', pageNumber)
  }
  return requestJson<ArtifactBundleResponse>(`/api/artifacts?${params.toString()}`)
}

/** 触发生成（force=true 时跳过幂等检查，追加新版本） */
export function generateArtifacts(
  videoUrl: string,
  options?: { pageNumber?: string | null; force?: boolean },
): Promise<ArtifactBundle> {
  return requestJson<ArtifactBundle>('/api/artifacts/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoUrl,
      pageNumber: options?.pageNumber ?? null,
      force: options?.force ?? true,
    }),
  })
}
