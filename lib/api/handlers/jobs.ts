import type { NextApiRequest, NextApiResponse } from 'next'
import type { JobError, JobStatus } from '~/lib/jobs/types'
import { buildBilibiliSourceRef, buildYoutubeSourceRef } from '~/lib/sources/sourceRef'
import type { V1Deps } from '../deps'
import { applyV1Cors, sendV1MethodNotAllowed } from '../http'
import { V1Error, sendV1Error } from '../errors'
import { authenticateV1, checkRateLimit } from './common'

/**
 * job 读取由路由层注入（默认实现 lib/api/jobReader.ts 走 lib/jobs engine）。
 * videoConfig 携带来源信息，handler 用它反查已落库的 contentId。
 */
export interface V1JobView {
  status: JobStatus
  error: JobError | null
  videoConfig?: {
    service?: string
    videoId: string
    pageNumber?: string | null
  }
}

export interface V1JobReader {
  get(jobId: string): Promise<V1JobView | null>
}

/** GET /api/v1/jobs/{id} → { jobId, status, error, contentId }（contentId 为契约细化附加字段） */
export async function handleV1JobsGet(
  req: NextApiRequest,
  res: NextApiResponse,
  deps: V1Deps,
  reader: V1JobReader,
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
  const { id } = req.query
  if (typeof id !== 'string' || !id) {
    sendV1Error(res, new V1Error('INVALID_REQUEST', 'missing job id'))
    return
  }
  let job: V1JobView | null = null
  try {
    job = await reader.get(id)
  } catch {
    job = null
  }
  if (!job) {
    sendV1Error(res, new V1Error('NOT_FOUND', `job not found: ${id}`))
    return
  }
  const contentId = await resolveContentIdQuietly(deps, auth.userId, job.videoConfig)
  res.status(200).json({ jobId: id, status: job.status, error: job.error, contentId })
}

async function resolveContentIdQuietly(
  deps: V1Deps,
  userId: string,
  videoConfig: V1JobView['videoConfig'],
): Promise<string | null> {
  if (!deps.supabase || !videoConfig) {
    return null
  }
  const service = videoConfig.service ?? 'youtube'
  const sourceRef =
    service === 'youtube'
      ? buildYoutubeSourceRef(videoConfig.videoId)
      : buildBilibiliSourceRef(videoConfig.videoId, videoConfig.pageNumber ?? null)
  let query = deps.supabase
    .from('contents')
    .select('id')
    .eq('user_id', userId)
    .eq('service', service)
    .eq('source_ref', sourceRef)
  query =
    videoConfig.pageNumber == null ? query.is('source_page', null) : query.eq('source_page', videoConfig.pageNumber)
  const { data, error } = await query.maybeSingle()
  if (error) {
    return null
  }
  return (data as { id: string } | null)?.id ?? null
}
