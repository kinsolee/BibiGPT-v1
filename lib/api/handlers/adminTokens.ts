import type { NextApiRequest, NextApiResponse } from 'next'
import { redactSecrets } from '~/lib/models/errors'
import type { V1Deps } from '../deps'
import { V1Error, sendV1Error } from '../errors'
import { applyV1Cors, readHeaderString, readJsonBody, sendV1MethodNotAllowed } from '../http'
import type { V1TokenScope } from '../tokenStore'

export const V1_ADMIN_TOKEN_ENV = 'BIBI_V1_ADMIN_TOKEN'
export const V1_DEFAULT_USER_ID_ENV = 'BIBI_API_DEFAULT_USER_ID'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 管理面鉴权：独立 env BIBI_V1_ADMIN_TOKEN，经 header `x-admin-token` 提供。
 * 语义与 lib/jobs/adminAuth.ts 一致：未配置 token 一律 403（禁裸奔），
 * 配置后不匹配 401。与 v1 业务 token 完全独立。
 */
export function requireV1AdminAuth(req: NextApiRequest, res: NextApiResponse): boolean {
  const expected = process.env[V1_ADMIN_TOKEN_ENV]?.trim()
  if (!expected) {
    console.error(`[v1] ${V1_ADMIN_TOKEN_ENV} not configured; v1 admin API is disabled`)
    sendV1Error(res, new V1Error('FORBIDDEN', `admin API disabled: set ${V1_ADMIN_TOKEN_ENV}`))
    return false
  }
  const provided = readHeaderString(req, 'x-admin-token') || ''
  if (provided !== expected) {
    sendV1Error(res, new V1Error('UNAUTHORIZED', 'invalid admin token'))
    return false
  }
  return true
}

/**
 * POST /api/v1/admin/tokens — body { scope, userId?, name? } → 201 { token, tokenId, ... }
 * GET  /api/v1/admin/tokens — → { tokens: [...] }
 */
export async function handleV1AdminTokens(req: NextApiRequest, res: NextApiResponse, deps: V1Deps): Promise<void> {
  if (applyV1Cors(req, res)) {
    return
  }
  if (req.method === 'POST') {
    if (!requireV1AdminAuth(req, res)) {
      return
    }
    const body = readJsonBody(req)
    if (typeof body !== 'object' || body === null) {
      sendV1Error(res, new V1Error('INVALID_REQUEST', 'request body must be a JSON object'))
      return
    }
    const { scope, userId, name } = body as { scope?: unknown; userId?: unknown; name?: unknown }
    if (scope !== 'read' && scope !== 'write') {
      sendV1Error(res, new V1Error('INVALID_REQUEST', "scope must be 'read' or 'write'"))
      return
    }
    const resolvedUserId =
      (typeof userId === 'string' && userId.trim()) || process.env[V1_DEFAULT_USER_ID_ENV]?.trim() || ''
    if (!resolvedUserId) {
      sendV1Error(res, new V1Error('INVALID_REQUEST', `userId is required (or set ${V1_DEFAULT_USER_ID_ENV})`))
      return
    }
    if (!UUID_PATTERN.test(resolvedUserId)) {
      sendV1Error(res, new V1Error('INVALID_REQUEST', 'userId must be a uuid'))
      return
    }
    try {
      const created = await deps.tokenStore.create({
        userId: resolvedUserId,
        scope,
        name: typeof name === 'string' ? name : '',
      })
      res.status(201).json({
        token: created.token,
        tokenId: created.record.id,
        scope: created.record.scope,
        userId: created.record.userId,
        name: created.record.name,
        createdAt: created.record.createdAt,
      })
    } catch (error) {
      console.error(
        `[v1] admin token create failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      )
      sendV1Error(res, new V1Error('INTERNAL', 'token create failed'))
    }
    return
  }
  if (req.method === 'GET') {
    if (!requireV1AdminAuth(req, res)) {
      return
    }
    try {
      const tokens = await deps.tokenStore.list()
      res.status(200).json({
        tokens: tokens.map((record) => ({
          tokenId: record.id,
          scope: record.scope,
          name: record.name,
          revoked: record.revoked,
          userId: record.userId,
          createdAt: record.createdAt,
          lastUsedAt: record.lastUsedAt,
        })),
      })
    } catch (error) {
      console.error(
        `[v1] admin token list failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      )
      sendV1Error(res, new V1Error('INTERNAL', 'token list failed'))
    }
    return
  }
  sendV1MethodNotAllowed(res, 'GET, POST')
}

/** DELETE /api/v1/admin/tokens/{tokenId} → { tokenId, revoked: true } */
export async function handleV1AdminTokenRevoke(req: NextApiRequest, res: NextApiResponse, deps: V1Deps): Promise<void> {
  if (applyV1Cors(req, res)) {
    return
  }
  if (req.method !== 'DELETE') {
    sendV1MethodNotAllowed(res, 'DELETE')
    return
  }
  if (!requireV1AdminAuth(req, res)) {
    return
  }
  const { tokenId } = req.query
  if (typeof tokenId !== 'string' || !tokenId) {
    sendV1Error(res, new V1Error('INVALID_REQUEST', 'missing tokenId'))
    return
  }
  try {
    const revoked = await deps.tokenStore.revoke(tokenId)
    if (!revoked) {
      sendV1Error(res, new V1Error('NOT_FOUND', `token not found: ${tokenId}`))
      return
    }
    res.status(200).json({ tokenId, revoked: true })
  } catch (error) {
    console.error(
      `[v1] admin token revoke failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    )
    sendV1Error(res, new V1Error('INTERNAL', 'token revoke failed'))
  }
}
