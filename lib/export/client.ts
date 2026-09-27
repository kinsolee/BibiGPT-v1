// KIN-47 导出模块浏览器端 API 封装（与 lib/artifacts/client.ts 同构）。
import type { ExportDeliveryDTO, ExportIntegrationDTO, ExportProviderMeta, ExportRenderResponse } from './types'

export class ExportApiError extends Error {
  status: number
  code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ExportApiError'
    this.status = status
    this.code = code
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    throw new ExportApiError(
      response.status,
      body?.error?.code ?? 'request_failed',
      body?.error?.message || `导出请求失败（${response.status}）`,
    )
  }
  return response.json() as Promise<T>
}

export function renderExportApi(
  params: { contentId?: string | null; videoUrl?: string | null; pageNumber?: string | null },
  format: string,
): Promise<ExportRenderResponse> {
  return requestJson<ExportRenderResponse>('/api/export/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...params, format }),
  })
}

export type ExportIntegrationsResponse = {
  integrations: ExportIntegrationDTO[]
  providers: ExportProviderMeta[]
}

export function fetchExportIntegrations(): Promise<ExportIntegrationsResponse> {
  return requestJson<ExportIntegrationsResponse>('/api/export/integrations')
}

export function saveExportIntegration(
  provider: string,
  secret: string,
): Promise<{ integration: ExportIntegrationDTO }> {
  return requestJson<{ integration: ExportIntegrationDTO }>('/api/export/integrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, secret }),
  })
}

export function revokeExportIntegration(provider: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/export/integrations?provider=${encodeURIComponent(provider)}`, {
    method: 'DELETE',
  })
}

export function deliverExportApi(params: {
  contentId?: string | null
  videoUrl?: string | null
  pageNumber?: string | null
  provider: string
}): Promise<{ delivery: ExportDeliveryDTO }> {
  return requestJson<{ delivery: ExportDeliveryDTO }>('/api/export/deliver', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
}

export function fetchExportDeliveries(params: {
  contentId?: string | null
  videoUrl?: string | null
  pageNumber?: string | null
  limit?: number
}): Promise<{ items: ExportDeliveryDTO[] }> {
  const search = new URLSearchParams()
  if (params.contentId) {
    search.set('contentId', params.contentId)
  }
  if (params.videoUrl) {
    search.set('videoUrl', params.videoUrl)
  }
  if (params.pageNumber) {
    search.set('pageNumber', params.pageNumber)
  }
  if (params.limit) {
    search.set('limit', String(params.limit))
  }
  return requestJson<{ items: ExportDeliveryDTO[] }>(`/api/export/deliveries?${search.toString()}`)
}

export function retryExportDelivery(deliveryId: string): Promise<{ delivery: ExportDeliveryDTO }> {
  return requestJson<{ delivery: ExportDeliveryDTO }>('/api/export/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deliveryId }),
  })
}
