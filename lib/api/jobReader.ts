import { getSharedJobEngine } from '~/lib/jobs/summaryJob'
import type { V1JobReader } from './handlers/jobs'

/** 默认 job 读取：复用 lib/jobs engine 的 getJob（Redis job store） */
export const defaultV1JobReader: V1JobReader = {
  async get(jobId) {
    const snapshot = await getSharedJobEngine().getJob(jobId)
    if (!snapshot) {
      return null
    }
    const { status, error } = snapshot.record
    const { service, videoId, pageNumber } = snapshot.record.params.videoConfig
    return {
      status,
      error,
      videoConfig: { service, videoId, pageNumber: pageNumber ?? null },
    }
  },
}
