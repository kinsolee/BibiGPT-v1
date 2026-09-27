import type { NextApiRequest, NextApiResponse } from 'next'
import { requireUserId } from '~/lib/history/server'
import { retryDelivery } from '~/lib/export/service'
import { bodyString, methodNotAllowed, sendExportError } from '~/lib/export/api'

/** POST /api/export/retry：对失败（或任意历史）投递重新执行，新增一条尝试记录 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    methodNotAllowed(res, ['POST'])
    return
  }
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  try {
    const deliveryId = bodyString(req.body, 'deliveryId')
    if (!deliveryId) {
      return res.status(400).json({ error: { code: 'invalid_request', message: '缺少 deliveryId' } })
    }
    const delivery = await retryDelivery(auth.supabase, auth.userId, deliveryId)
    return res.status(200).json({ delivery })
  } catch (error) {
    sendExportError(res, error)
  }
}
