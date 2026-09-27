import type { NextApiRequest, NextApiResponse } from 'next'
import { requireUserId } from '~/lib/history/server'
import { listIntegrations, providerMeta, revokeIntegration, upsertIntegration } from '~/lib/export/service'
import { isExportProviderId } from '~/lib/export/providers/types'
import { bodyString, methodNotAllowed, sendExportError } from '~/lib/export/api'

/**
 * GET    /api/export/integrations            集成列表（脱敏，secret 不出服务端）+ provider 元信息
 * POST   /api/export/integrations            配置/更新 webhook 集成（secret 加密存库）
 * DELETE /api/export/integrations?provider=  撤销集成
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  try {
    if (req.method === 'GET') {
      const integrations = await listIntegrations(auth.supabase, auth.userId)
      return res.status(200).json({ integrations, providers: providerMeta() })
    }
    if (req.method === 'POST') {
      const provider = bodyString(req.body, 'provider')
      const secret = bodyString(req.body, 'secret')
      if (!provider || !isExportProviderId(provider)) {
        return res.status(400).json({ error: { code: 'invalid_provider', message: 'provider 不合法' } })
      }
      if (!secret || secret.length > 2048) {
        return res.status(400).json({ error: { code: 'invalid_secret', message: 'secret 缺失或超长' } })
      }
      const displayName = bodyString(req.body, 'displayName')
      const integration = await upsertIntegration(auth.supabase, auth.userId, { provider, secret, displayName })
      return res.status(200).json({ integration })
    }
    if (req.method === 'DELETE') {
      const provider = typeof req.query.provider === 'string' ? req.query.provider : null
      if (!provider || !isExportProviderId(provider)) {
        return res.status(400).json({ error: { code: 'invalid_provider', message: 'provider 不合法' } })
      }
      await revokeIntegration(auth.supabase, auth.userId, provider)
      return res.status(200).json({ ok: true })
    }
    methodNotAllowed(res, ['GET', 'POST', 'DELETE'])
  } catch (error) {
    sendExportError(res, error)
  }
}
