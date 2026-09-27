import { BatchCollectionDetailDTO, BatchCollectionDTO, BatchItemDTO } from '~/lib/batch/dto'

export class BatchApiError extends Error {
  status: number
  code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'BatchApiError'
    this.status = status
    this.code = code
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new BatchApiError(response.status, body?.message || `请求失败（${response.status}）`, body?.error)
  }
  return response.json()
}

export function fetchBatchCollections() {
  return requestJson<{ collections: BatchCollectionDTO[] }>('/api/collections')
}

export function fetchBatchCollectionDetail(id: string) {
  return requestJson<{ collection: BatchCollectionDetailDTO }>(`/api/collections/${id}`)
}

export function importCollectionRequest(url: string) {
  return requestJson<{ collection: BatchCollectionDetailDTO; imported: number; duplicates: number }>(
    '/api/collections',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    },
  )
}

export function deleteBatchCollection(id: string) {
  return requestJson<{ deleted: boolean; id: string }>(`/api/collections/${id}`, { method: 'DELETE' })
}

export type BatchCollectionAction = 'start' | 'pause' | 'cancel' | 'retryFailed' | 'clearFailed'

export type BatchActionResponse = {
  action: BatchCollectionAction
  active?: boolean
  pendingItems?: number
  removed?: number
  batchStatus?: string
}

export function batchCollectionAction(collectionId: string, action: BatchCollectionAction) {
  return requestJson<BatchActionResponse>(`/api/batch/${collectionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
}

export type BatchItemAction = 'start' | 'retry' | 'cancel'

export function batchItemAction(itemId: string, action: BatchItemAction) {
  return requestJson<{ action: BatchItemAction; item: BatchItemDTO }>(`/api/batch/items/${itemId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
}

export function removeBatchItem(itemId: string) {
  return requestJson<{ deleted: boolean; item: BatchItemDTO }>(`/api/batch/items/${itemId}`, { method: 'DELETE' })
}

export function fetchWatchLater() {
  return requestJson<{ collection: BatchCollectionDTO; items: BatchItemDTO[] }>('/api/watch-later')
}

export function addWatchLaterUrls(urls: string[]) {
  return requestJson<{ added: number; duplicates: number; invalidUrls: string[] }>('/api/watch-later', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  })
}

export function removeWatchLaterItem(id: string) {
  return requestJson<{ deleted: boolean; id: string }>(`/api/watch-later?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}
