import type { NextApiRequest, NextApiResponse } from 'next'
import { batchErrorResponse, toItemDTO } from '~/lib/batch/dto'
import { BatchError } from '~/lib/batch/types'
import { cancelItem, removeItem, retryItem, runSingleItem } from '~/lib/batch/worker'
import { requireUserId } from '~/lib/history/server'

type ItemAction = 'start' | 'retry' | 'cancel'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }

  const { itemId } = req.query
  if (typeof itemId !== 'string' || !itemId) {
    return res.status(400).json({ error: 'bad_request', message: 'missing itemId' })
  }

  try {
    if (req.method === 'POST') {
      const body = req.body as { action?: unknown } | undefined
      const action = body?.action
      if (action !== 'start' && action !== 'retry' && action !== 'cancel') {
        return res.status(400).json({ error: 'bad_request', message: 'action 必须是 start/retry/cancel' })
      }
      if (action === 'cancel') {
        const item = await cancelItem(auth.supabase, auth.userId, itemId)
        return res.status(200).json({ action, item: toItemDTO(item) })
      }
      // start / retry 统一走单项执行（await 到终态，长任务）
      const item =
        action === 'retry'
          ? await retryItem(auth.supabase, auth.userId, itemId)
          : await runSingleItem(auth.supabase, auth.userId, itemId)
      return res.status(200).json({ action, item: toItemDTO(item) })
    }

    if (req.method === 'DELETE') {
      const item = await removeItem(auth.supabase, auth.userId, itemId)
      return res.status(200).json({ deleted: true, item: toItemDTO(item) })
    }

    res.setHeader('Allow', 'POST, DELETE')
    return res.status(405).json({ error: 'method_not_allowed' })
  } catch (error: unknown) {
    return batchErrorResponse(res, error)
  }
}
