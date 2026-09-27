import type { NextApiRequest, NextApiResponse } from 'next'
import { redactSecrets } from '~/lib/models/errors'
import { V1Error, sendV1Error } from '../errors'
import { readHeaderString } from '../http'
import { requestBodyHash } from '../idempotency'
import type { IdempotencyStore } from '../idempotency'
import type { RateLimiter } from '../ratelimit'
import type { ApiTokenStore, V1TokenScope } from '../tokenStore'
import { hashApiToken } from '../tokenStore'
import type { V1Deps } from '../deps'

export interface V1AuthContext {
  tokenId: string
  scope: V1TokenScope
  userId: string
}

/**
 * Bearer token 鉴权：缺失/格式错/查无/已撤销 → 401 UNAUTHORIZED；
 * token store 自身不可用（未配置 service key）→ 500 INTERNAL。
 * 命中后 fire-and-forget 刷新 last_used_at。
 */
export async function authenticateV1(
  req: NextApiRequest,
  res: NextApiResponse,
  deps: V1Deps,
): Promise<V1AuthContext | null> {
  const header = readHeaderString(req, 'authorization')
  if (!header?.startsWith('Bearer ')) {
    sendV1Error(res, new V1Error('UNAUTHORIZED', 'missing or malformed Authorization header, expected: Bearer <token>'))
    return null
  }
  const token = header.slice('Bearer '.length).trim()
  if (!token) {
    sendV1Error(res, new V1Error('UNAUTHORIZED', 'missing bearer token'))
    return null
  }
  let record: Awaited<ReturnType<ApiTokenStore['findByTokenHash']>> = null
  try {
    record = await deps.tokenStore.findByTokenHash(await hashApiToken(token))
  } catch (error) {
    if (error instanceof V1Error) {
      sendV1Error(res, error)
      return null
    }
    console.error(`[v1] token lookup failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`)
    sendV1Error(res, new V1Error('INTERNAL', 'token lookup failed'))
    return null
  }
  if (!record || record.revoked) {
    sendV1Error(res, new V1Error('UNAUTHORIZED', 'invalid or revoked token'))
    return null
  }
  deps.tokenStore.touchLastUsed(record.id)
  return { tokenId: record.id, scope: record.scope, userId: record.userId }
}

/** 写操作 scope 检查：read token 调写端点 → 403 FORBIDDEN（scope 语义：write 含 read） */
export function requireWriteScope(ctx: V1AuthContext, res: NextApiResponse): boolean {
  if (ctx.scope !== 'write') {
    sendV1Error(res, new V1Error('FORBIDDEN', 'token scope is read; write operations require a write-scope token'))
    return false
  }
  return true
}

/** 每 token 限流（BIBI_V1_RATE_LIMIT_PER_MINUTE，默认 120/min）；超限 → 429 + Retry-After */
export async function checkRateLimit(
  ctx: V1AuthContext,
  res: NextApiResponse,
  rateLimiter: RateLimiter,
): Promise<boolean> {
  let result
  try {
    result = await rateLimiter.limit(`v1token:${ctx.tokenId}`)
  } catch (error) {
    // 限流存储不可用时放行（fail-open），不让 Redis 故障阻断 API
    console.error(
      `[v1] rate limiter failed (fail-open): ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    )
    return true
  }
  if (!result.success) {
    if (result.retryAfterSeconds) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds))
    }
    sendV1Error(res, new V1Error('RATE_LIMITED', 'rate limit exceeded, retry later'))
    return false
  }
  return true
}

/**
 * Idempotency-Key 编排：同 key 同 body 重放首次结果（Idempotency-Replayed: true），
 * 同 key 不同 body → 409 IDEMPOTENCY_CONFLICT。仅存确定性结果（<500 且非 429）。
 * store 故障时降级为直接执行（fail-open），不阻断请求。
 */
export async function withV1Idempotency(
  req: NextApiRequest,
  res: NextApiResponse,
  idempotencyStore: IdempotencyStore,
  ctx: V1AuthContext,
  route: string,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  const key = readHeaderString(req, 'idempotency-key')
  if (!key) {
    const { status, body } = await run()
    res.status(status).json(body)
    return
  }
  const storeKey = `${route}:${ctx.tokenId}:${key.slice(0, 200)}`
  let bodyHash: string
  try {
    bodyHash = await requestBodyHash(req.body ?? null)
  } catch (error) {
    console.error(
      `[v1] idempotency bodyHash failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    )
    const { status, body } = await run()
    res.status(status).json(body)
    return
  }
  let existing: Awaited<ReturnType<IdempotencyStore['get']>> = null
  try {
    existing = await idempotencyStore.get(storeKey)
  } catch (error) {
    console.error(
      `[v1] idempotency lookup failed (fail-open): ${redactSecrets(
        error instanceof Error ? error.message : String(error),
      )}`,
    )
  }
  if (existing) {
    if (existing.bodyHash !== bodyHash) {
      sendV1Error(
        res,
        new V1Error('IDEMPOTENCY_CONFLICT', 'this Idempotency-Key was already used with a different request body'),
      )
      return
    }
    res.setHeader('Idempotency-Replayed', 'true')
    res.status(existing.httpStatus).json(existing.body)
    return
  }
  const { status, body } = await run()
  if (status < 500 && status !== 429) {
    try {
      await idempotencyStore.set(storeKey, { bodyHash, httpStatus: status, body })
    } catch (error) {
      console.error(
        `[v1] idempotency store failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
      )
    }
  }
  res.status(status).json(body)
}
