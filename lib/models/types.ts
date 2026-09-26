export type UpstreamErrorKind =
  | 'MODEL_NOT_FOUND'
  | 'CAPABILITY_UNSUPPORTED'
  | 'UPSTREAM_AUTH'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'UPSTREAM_5XX'
  | 'UNKNOWN'

export interface ClassifiedUpstreamError {
  kind: UpstreamErrorKind
  httpStatus: number
  message: string
}

export interface CacheIdContext {
  provider: string
  promptVersion: string
  model?: string
  /** Prompt template generation; changes when lib/openai/prompt.ts templates change. */
  templateVersion?: string
  /** Short hash of the transcript/description input; absent means the caller could not provide it. */
  transcriptHash?: string
}

export interface ResolvedModelTarget {
  provider: string
  model: string
  baseUrl: string
  isDefaultModel: boolean
}
