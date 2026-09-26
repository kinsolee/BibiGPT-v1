/** job 管线错误码 → HTTP 状态（沿用 lib/models/errors 的上游口径，补充管线自有码） */
const JOB_ERROR_HTTP_STATUS: Record<string, number> = {
  CANCELED: 499,
  TIMEOUT: 504,
  RATE_LIMITED: 429,
  UPSTREAM_AUTH: 502,
  UPSTREAM_5XX: 502,
  MODEL_NOT_FOUND: 400,
  CAPABILITY_UNSUPPORTED: 400,
  PROVIDER_ERROR_PAGE: 502,
  CHUNK_NOT_FOUND: 500,
  REDUCE_INPUT_EMPTY: 500,
  STEP_FAILED: 502,
  JOB_NOT_SUCCEEDED: 502,
  UNKNOWN: 500,
}

export function jobErrorToHttpStatus(code: string) {
  return JOB_ERROR_HTTP_STATUS[code] ?? 502
}
