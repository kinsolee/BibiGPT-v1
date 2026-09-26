import { UserConfig, VideoConfig } from '~/lib/types'

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
export type StepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
export type StepKind = 'chunk' | 'reduce'

/** job/step 失败记录：code 为分类错误码（上游 kind 或管线错误码），message 已脱敏截断 */
export interface JobError {
  code: string
  message: string
  stepIndex?: number
}

/** 摘要 job 的最小 chunk 快照（文本随 job 持久化，重启续传无需重新抓字幕） */
export interface JobChunkSpec {
  index: number
  hash: string
  text: string
  byteLength: number
  startSeconds: number | null
  endSeconds: number | null
}

export interface JobStepRecord {
  /** chunks 为 0..N-1，reduce 步骤固定为 N */
  index: number
  kind: StepKind
  chunkIndex: number | null
  chunkHash: string | null
  status: StepStatus
  /** 当前这轮执行的尝试次数；succeeded 后保留最终值 */
  attempt: number
  maxAttempts: number
  startedAt: number | null
  finishedAt: number | null
  error: JobError | null
  /** 步骤产出（chunk 摘要或最终摘要）；failed/canceled 时可能为空 */
  output: string
}

export interface SummaryJobParams {
  videoConfig: VideoConfig
  userConfig: UserConfig
  title: string | null
  chunks: JobChunkSpec[]
  model: string
  provider: string
  baseUrl: string
  promptVersion: string
  detailTokens: number
  /** 仅运行时使用：持久化进 job store 前会被剥离，续传时由当次请求重新注入 */
  apiKey: string
}

export interface JobRecord {
  id: string
  digest: string
  kind: 'summary'
  videoId: string
  status: JobStatus
  /** 第几次执行（重启/重试各 +1），从 1 开始 */
  attempt: number
  createdAt: number
  updatedAt: number
  startedAt: number | null
  finishedAt: number | null
  /** 已成功的 chunk index 列表（重启续传 checkpoint） */
  checkpoint: number[]
  error: JobError | null
  resultText: string | null
  params: SummaryJobParams
}

export interface JobSnapshot {
  record: JobRecord
  steps: JobStepRecord[]
}

export const TERMINAL_JOB_STATUSES: ReadonlyArray<JobStatus> = ['succeeded', 'failed', 'canceled']

export function isTerminalJobStatus(status: JobStatus) {
  return TERMINAL_JOB_STATUSES.includes(status)
}
