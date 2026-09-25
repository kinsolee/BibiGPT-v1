import { HistoryDetailDTO, HistoryListResponse } from '~/lib/history/types'

export class HistoryApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HistoryApiError'
    this.status = status
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new HistoryApiError(response.status, body?.message || `请求失败（${response.status}）`)
  }
  return response.json()
}

export type HistoryListQuery = {
  q?: string
  service?: string
  favorite?: boolean
  page?: number
  pageSize?: number
}

export function fetchHistoryList(query: HistoryListQuery = {}) {
  const params = new URLSearchParams()
  if (query.q) {
    params.set('q', query.q)
  }
  if (query.service) {
    params.set('service', query.service)
  }
  if (query.favorite) {
    params.set('favorite', '1')
  }
  if (query.page) {
    params.set('page', String(query.page))
  }
  if (query.pageSize) {
    params.set('pageSize', String(query.pageSize))
  }
  const qs = params.toString()
  return requestJson<HistoryListResponse>(`/api/history${qs ? `?${qs}` : ''}`)
}

export function fetchHistoryDetail(id: string) {
  return requestJson<HistoryDetailDTO>(`/api/history/${id}`)
}

export function deleteHistoryItem(id: string) {
  return requestJson<{ deleted: boolean; id: string }>(`/api/history/${id}`, { method: 'DELETE' })
}

export function toggleHistoryFavorite(id: string) {
  return requestJson<{ id: string; isFavorite: boolean }>(`/api/history/${id}/favorite`, { method: 'POST' })
}

export type RegenerateResult = {
  contentId: string
  summaryId: string
  version: number
  reused: boolean
  summaryText: string
  note: string
}

export function regenerateHistorySummary(id: string) {
  return requestJson<RegenerateResult>(`/api/history/${id}/regenerate`, { method: 'POST' })
}
