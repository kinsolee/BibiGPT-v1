import { getSharedJobEngine } from '~/lib/jobs/summaryJob'
import { buildBilibiliSourceRef, buildYoutubeSourceRef } from '~/lib/sources/sourceRef'
import { VideoService } from '~/lib/types'
import { isJobAccessible } from './jobOwnership'
import { getServiceSupabase } from './supabaseService'
import type { V1JobReader } from './handlers/jobs'

/**
 * 默认 job 读取：复用 lib/jobs engine 的 getJob（Redis job store）。
 * 归属校验：job digest 不含用户标识，跨用户共享 jobId，因此读取前必须
 * 确认请求用户提交过此 job（v1 登记表）或已落库过同源内容；否则返回
 * null → 404，不泄漏存在性。
 */
export const defaultV1JobReader: V1JobReader = {
  async get(jobId, userId) {
    const snapshot = await getSharedJobEngine().getJob(jobId)
    if (!snapshot) {
      return null
    }
    const { status, error } = snapshot.record
    const { service, videoId, pageNumber } = snapshot.record.params.videoConfig
    const serviceStr = service === VideoService.Youtube ? 'youtube' : 'bilibili'
    const accessible = await isJobAccessible({
      supabase: getServiceSupabase(),
      jobId,
      userId,
      sourceKey: {
        service: serviceStr,
        sourceRef:
          serviceStr === 'youtube'
            ? buildYoutubeSourceRef(videoId)
            : buildBilibiliSourceRef(videoId, pageNumber ?? null),
        sourcePage: pageNumber ?? null,
      },
    }).catch(() => false)
    if (!accessible) {
      return null
    }
    return {
      status,
      error,
      videoConfig: { service, videoId, pageNumber: pageNumber ?? null },
    }
  },
}
