import { ClassifiedUpstreamError, UpstreamErrorKind } from '~/lib/models/types'

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|rk)-[A-Za-z0-9_-]{6,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /\b(?:api[-_]?key|authorization|token)["':=\s]+[A-Za-z0-9._~+/=-]{10,}/gi,
]

export function redactSecrets(text: string) {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, '[REDACTED]'), text)
}

const KIND_TO_HTTP_STATUS: Record<UpstreamErrorKind, number> = {
  MODEL_NOT_FOUND: 400,
  CAPABILITY_UNSUPPORTED: 400,
  UPSTREAM_AUTH: 502,
  RATE_LIMITED: 429,
  TIMEOUT: 504,
  UPSTREAM_5XX: 502,
  UNKNOWN: 500,
}

function truncate(text: string, max = 300) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function classifyUpstreamError(error: unknown): ClassifiedUpstreamError {
  const anyError = error as { statusCode?: unknown; name?: unknown; message?: unknown; responseBody?: unknown }
  const statusCode = typeof anyError?.statusCode === 'number' ? anyError.statusCode : undefined
  const message = redactSecrets(String(anyError?.message ?? 'Unknown error'))
  const body = redactSecrets(String(anyError?.responseBody ?? ''))
  const combined = `${message} ${body}`.toLowerCase()

  let kind: UpstreamErrorKind = 'UNKNOWN'
  if (anyError?.name === 'AbortError' || /timeout|timed\s*out|etimedout|aborted/.test(combined)) {
    kind = 'TIMEOUT'
  } else if (statusCode === 429 || /rate.?limit|too many requests|quota exceeded/.test(combined)) {
    kind = 'RATE_LIMITED'
  } else if (
    statusCode === 401 ||
    statusCode === 403 ||
    /unauthorized|invalid api key|incorrect api key|authentication|api key not valid/.test(combined)
  ) {
    kind = 'UPSTREAM_AUTH'
  } else if (
    statusCode === 404 ||
    /model .*(not found|not exist|not supported|unsupported)|no such model|unknown model|unknown parameter|invalid model|模型不存在|无效的模型|未知模型|不存在的模型/.test(
      combined,
    )
  ) {
    kind = 'MODEL_NOT_FOUND'
  } else if (/modality|capabilit|image input|audio input|vision-only|multimodal input/.test(combined)) {
    kind = 'CAPABILITY_UNSUPPORTED'
  } else if (
    (statusCode ?? 0) >= 500 ||
    /internal server error|bad gateway|service unavailable|overloaded/.test(combined)
  ) {
    kind = 'UPSTREAM_5XX'
  }

  return {
    kind,
    httpStatus: KIND_TO_HTTP_STATUS[kind],
    message: truncate(body || message),
  }
}
