import type { NextApiRequest, NextApiResponse } from 'next'
import { requireUserId } from '~/lib/history/server'
import { deliverToProvider } from '~/lib/export/service'
import { isExportProviderId } from '~/lib/export/providers/types'
import { bodyString, methodNotAllowed, sendExportError } from '~/lib/export/api'

/** POST /api/export/deliver：把既有 summary/artifact 投递到第三方集成（不触发生成） */
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
    const provider = bodyString(req.body, 'provider')
    if (!provider || !isExportProviderId(provider)) {
      return res.status(400).json({ error: { code: 'invalid_provider', message: 'provider 不合法' } })
    }
    const delivery = await deliverToProvider(auth.supabase, auth.userId, {
      provider,
      contentId: bodyString(req.body, 'contentId'),
      videoUrl: bodyString(req.body, 'videoUrl'),
      pageNumber: bodyString(req.body, 'pageNumber'),
    })
    return res.status(200).json({ delivery })
  } catch (error) {
    sendExportError(res, error)
  }
}
