import type { NextApiRequest, NextApiResponse } from 'next'
import { batchErrorResponse } from '~/lib/batch/dto'
import {
  cancelBatch,
  clearFailedItems,
  isCollectionBatchActive,
  pauseBatch,
  retryFailedItems,
  startBatch,
} from '~/lib/batch/worker'
import { BatchError } from '~/lib/batch/types'
import { requireUserId } from '~/lib/history/server'

type BatchAction = 'start' | 'pause' | 'cancel' | 'retryFailed' | 'clearFailed'

function isBatchAction(value: unknown): value is BatchAction {
  return (
    value === 'start' || value === 'pause' || value === 'cancel' || value === 'retryFailed' || value === 'clearFailed'
  )
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }

  const { collectionId } = req.query
  if (typeof collectionId !== 'string' || !collectionId) {
    return res.status(400).json({ error: 'bad_request', message: 'missing collectionId' })
  }

  const body = req.body as { action?: unknown } | undefined
  if (!isBatchAction(body?.action)) {
    return res
      .status(400)
      .json({ error: 'bad_request', message: 'action 必须是 start/pause/cancel/retryFailed/clearFailed' })
  }
  const action = body.action

  try {
    switch (action) {
      case 'start': {
        const result = await startBatch(auth.supabase, auth.userId, collectionId)
        return res.status(202).json({ action, active: true, ...result })
      }
      case 'pause': {
        await pauseBatch(auth.supabase, auth.userId, collectionId)
        return res
          .status(200)
          .json({ action, batchStatus: 'paused', workerActive: isCollectionBatchActive(collectionId) })
      }
      case 'cancel': {
        await cancelBatch(auth.supabase, auth.userId, collectionId)
        return res
          .status(200)
          .json({ action, batchStatus: 'idle', workerActive: isCollectionBatchActive(collectionId) })
      }
      case 'retryFailed': {
        const result = await retryFailedItems(auth.supabase, auth.userId, collectionId)
        return res.status(202).json({ action, active: true, ...result })
      }
      case 'clearFailed': {
        const result = await clearFailedItems(auth.supabase, auth.userId, collectionId)
        return res.status(200).json({ action, ...result })
      }
    }
  } catch (error: unknown) {
    return batchErrorResponse(res, error)
  }
}
