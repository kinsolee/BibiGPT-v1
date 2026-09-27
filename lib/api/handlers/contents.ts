import type { SupabaseClient } from '@supabase/supabase-js'
import type { ArtifactBundle } from '~/lib/artifacts/types'
import type { TranscriptSegment } from '~/lib/sources/types'
import type { NextApiRequest, NextApiResponse } from 'next'
import type { V1Deps } from '../deps'
import { V1Error, sendV1Error } from '../errors'
import { applyV1Cors, sendV1MethodNotAllowed } from '../http'
import { authenticateV1, checkRateLimit } from './common'

export interface V1ContentRow {
  id: string
  title: string | null
  sourceUrl: string
}

/** contents 读取由路由层注入（默认实现 lib/api/contentReader.ts 查 Supabase） */
export interface V1ContentReader {
  getContent(contentId: string, userId: string): Promise<V1ContentRow | null>
  getLatestSummaryText(contentId: string): Promise<string | null>
  getTranscript(contentId: string): Promise<{ lang: string | null; segments: TranscriptSegment[] }>
  getArtifact?(contentId: string, userId: string): Promise<ArtifactBundle | null>
}

/** GET /api/v1/contents/{contentId} → { contentId, title, sourceUrl, summaryText, artifact? } */
export async function handleV1ContentsGet(
  req: NextApiRequest,
  res: NextApiResponse,
  deps: V1Deps,
  reader: V1ContentReader,
): Promise<void> {
  if (applyV1Cors(req, res)) {
    return
  }
  if (req.method !== 'GET') {
    sendV1MethodNotAllowed(res, 'GET')
    return
  }
  const auth = await authenticateV1(req, res, deps)
  if (!auth) {
    return
  }
  if (!(await checkRateLimit(auth, res, deps.rateLimiter))) {
    return
  }
  const contentId = req.query.contentId
  if (typeof contentId !== 'string' || !contentId) {
    sendV1Error(res, new V1Error('INVALID_REQUEST', 'missing contentId'))
    return
  }
  const content = await reader.getContent(contentId, auth.userId).catch(() => null)
  if (!content) {
    sendV1Error(res, new V1Error('NOT_FOUND', `content not found: ${contentId}`))
    return
  }
  const summaryText = await reader.getLatestSummaryText(contentId).catch(() => null)
  const responseBody: Record<string, unknown> = {
    contentId: content.id,
    title: content.title,
    sourceUrl: content.sourceUrl,
    summaryText,
  }
  if (req.query.artifact === '1' && reader.getArtifact) {
    responseBody.artifact = await reader.getArtifact(contentId, auth.userId).catch(() => null)
  }
  res.status(200).json(responseBody)
}

/** GET /api/v1/contents/{contentId}/transcript → { lang, segments: TranscriptSegment[] } */
export async function handleV1TranscriptGet(
  req: NextApiRequest,
  res: NextApiResponse,
  deps: V1Deps,
  reader: V1ContentReader,
): Promise<void> {
  if (applyV1Cors(req, res)) {
    return
  }
  if (req.method !== 'GET') {
    sendV1MethodNotAllowed(res, 'GET')
    return
  }
  const auth = await authenticateV1(req, res, deps)
  if (!auth) {
    return
  }
  if (!(await checkRateLimit(auth, res, deps.rateLimiter))) {
    return
  }
  const contentId = req.query.contentId
  if (typeof contentId !== 'string' || !contentId) {
    sendV1Error(res, new V1Error('INVALID_REQUEST', 'missing contentId'))
    return
  }
  const content = await reader.getContent(contentId, auth.userId).catch(() => null)
  if (!content) {
    sendV1Error(res, new V1Error('NOT_FOUND', `content not found: ${contentId}`))
    return
  }
  const transcript = await reader.getTranscript(contentId).catch(() => ({ lang: null, segments: [] }))
  res.status(200).json({ lang: transcript.lang, segments: transcript.segments })
}

/** 供默认 reader（lib/api/contentReader.ts）与 future 复用的公共查询 */
export async function findContentRow(
  supabase: SupabaseClient,
  userId: string,
  contentId: string,
): Promise<V1ContentRow | null> {
  const { data, error } = await supabase
    .from('contents')
    .select('id, title, source_url')
    .eq('id', contentId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    throw error
  }
  const row = data as { id: string; title: string | null; source_url: string } | null
  return row ? { id: row.id, title: row.title, sourceUrl: row.source_url } : null
}
