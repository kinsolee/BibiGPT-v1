import type { NextApiRequest, NextApiResponse } from 'next'

/**
 * job 管理面（状态查询/列表/取消/清理）的单一 owner token 校验。
 * 自用版不做 per-user 鉴权：token 配在 BIBI_JOB_ADMIN_TOKEN，
 * 请求经 header `x-admin-token` 或 query `?adminToken=` 提供。
 * 未配置 token 时管理面一律 403，避免裸奔上线。
 */
export const JOB_ADMIN_TOKEN_ENV = 'BIBI_JOB_ADMIN_TOKEN'

export function requireJobAdminAuth(req: NextApiRequest, res: NextApiResponse): boolean {
  const expected = process.env.BIBI_JOB_ADMIN_TOKEN?.trim()
  if (!expected) {
    console.error(`[jobs] ${JOB_ADMIN_TOKEN_ENV} not configured; job admin API is disabled`)
    res.status(403).json({ errorMessage: `job admin API disabled: set ${JOB_ADMIN_TOKEN_ENV}` })
    return false
  }
  const provided = (req.headers['x-admin-token'] as string | undefined)?.trim() || String(req.query.adminToken ?? '')
  if (provided !== expected) {
    res.status(401).json({ errorMessage: 'invalid admin token' })
    return false
  }
  return true
}
