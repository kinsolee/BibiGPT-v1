import { BATCH_MAX_ITEMS } from '~/lib/batch/types'
import type { NextApiRequest, NextApiResponse } from 'next'
import { parseVideoSourceUrl } from '~/lib/sources/registry'
import { buildBilibiliSourceRef, buildYoutubeSourceRef } from '~/lib/sources/sourceRef'
import type { V1Deps } from '../deps'
import { applyV1Cors, readJsonBody, sendV1MethodNotAllowed } from '../http'
import { authenticateV1, checkRateLimit, requireWriteScope, withV1Idempotency } from './common'

export interface V1ImportItem {
  rawUrl: string
  dedupeKey: string
  service: 'youtube' | 'bilibili'
}

export interface V1ImportResult {
  /** 实际写入 watch-later 的 dedupeKey 集合（其余为重复） */
  writtenKeys: string[]
  /** dedupeKey → 已有 content id（无已落库内容时缺省） */
  contentIdByDedupeKey: Record<string, string | null>
}

/**
 * import 写入由路由层注入：默认实现 lib/api/importer.ts 复用 lib/batch 的
 * getOrCreateWatchLaterCollection + addWatchLaterItems（只登记 pending item，
 * 绝不触发摘要——handler 层结构上就没有摘要管线入口）。
 */
export type V1Importer = (userId: string, items: V1ImportItem[]) => Promise<V1ImportResult>

export interface V1ImportResponseBody {
  imported: Array<{ sourceUrl: string; contentId: string | null; service: string }>
  duplicates: string[]
}

/**
 * POST /api/v1/import — body { urls: string[], target: 'watch-later' }
 * 仅支持 youtube/bilibili 单视频 URL（与 watch-later 去重键一致的子集）；
 * 含任何不支持 URL 时整体 422，不部分导入（对 Agent 客户端语义最清晰）。
 */
export async function handleV1Import(
  req: NextApiRequest,
  res: NextApiResponse,
  deps: V1Deps,
  importer: V1Importer,
): Promise<void> {
  if (applyV1Cors(req, res)) {
    return
  }
  if (req.method !== 'POST') {
    sendV1MethodNotAllowed(res, 'POST')
    return
  }
  const auth = await authenticateV1(req, res, deps)
  if (!auth) {
    return
  }
  if (!requireWriteScope(auth, res)) {
    return
  }
  if (!(await checkRateLimit(auth, res, deps.rateLimiter))) {
    return
  }
  const body = readJsonBody(req)
  await withV1Idempotency(req, res, deps.idempotencyStore, auth, 'import', async () => {
    const validationError = validateImportBody(body)
    if (validationError) {
      return { status: 400, body: { error: { code: 'INVALID_REQUEST', message: validationError } } }
    }
    const { urls, target } = body as { urls: string[]; target: string }
    if (target !== 'watch-later') {
      return {
        status: 400,
        body: { error: { code: 'INVALID_REQUEST', message: `unsupported target: ${target}, only 'watch-later'` } },
      }
    }
    const items: V1ImportItem[] = []
    const unsupported: string[] = []
    for (const rawUrl of urls) {
      const parsed = parseVideoSourceUrl(rawUrl.trim())
      if (!parsed) {
        unsupported.push(rawUrl)
        continue
      }
      const service = parsed.adapter.id === 'youtube' ? 'youtube' : 'bilibili'
      const dedupeKey =
        service === 'youtube'
          ? buildYoutubeSourceRef(parsed.videoId)
          : buildBilibiliSourceRef(parsed.videoId, parsed.pageNumber ?? null)
      items.push({ rawUrl: rawUrl.trim(), dedupeKey, service })
    }
    if (unsupported.length > 0) {
      return {
        status: 422,
        body: {
          error: {
            code: 'UNSUPPORTED_SOURCE',
            message: 'one or more urls are not supported video sources',
            details: { unsupported },
          },
        },
      }
    }

    // 请求内去重：首个出现者保留，后续按重复处理
    const seen = new Set<string>()
    const unique: V1ImportItem[] = []
    const inRequestDuplicates: string[] = []
    for (const item of items) {
      if (seen.has(item.dedupeKey)) {
        inRequestDuplicates.push(item.rawUrl)
        continue
      }
      seen.add(item.dedupeKey)
      unique.push(item)
    }

    let result: Awaited<ReturnType<V1Importer>>
    try {
      result = await importer(auth.userId, unique)
    } catch (error) {
      return {
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'import failed' } },
      }
    }
    const written = new Set(result.writtenKeys)
    const imported = unique
      .filter((item) => written.has(item.dedupeKey))
      .map((item) => ({
        sourceUrl: item.rawUrl,
        contentId: result.contentIdByDedupeKey[item.dedupeKey] ?? null,
        service: item.service,
      }))
    const duplicates = [
      ...inRequestDuplicates,
      ...unique.filter((item) => !written.has(item.dedupeKey)).map((item) => item.rawUrl),
    ]
    const responseBody: V1ImportResponseBody = { imported, duplicates }
    return { status: 200, body: responseBody }
  })
}

function validateImportBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) {
    return 'request body must be a JSON object with urls and target'
  }
  const { urls, target } = body as { urls?: unknown; target?: unknown }
  if (!Array.isArray(urls) || urls.length === 0) {
    return 'urls is required and must be a non-empty array of strings'
  }
  if (urls.length > BATCH_MAX_ITEMS) {
    return `at most ${BATCH_MAX_ITEMS} urls per request`
  }
  for (const url of urls) {
    if (typeof url !== 'string' || !url.trim()) {
      return 'urls must contain non-empty strings only'
    }
  }
  if (typeof target !== 'string' || !target) {
    return 'target is required (only "watch-later" is supported)'
  }
  return null
}
