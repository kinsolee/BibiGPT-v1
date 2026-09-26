/**
 * provider 有时会把网关错误以 200 + 文本形式返回：HTML 错误页或裸 JSON
 * 错误体（如 {"error":"rate_limit"}）。这类内容绝不能被当作摘要落库或
 * 进入 reduce 输入，统一在此识别拦截。
 */
const HTML_DOCUMENT_PATTERN = /^\s*(?:<(!doctype|html|head|body|\?xml|br\s*\/?|center|title)[\s>])/i
const HTML_ERROR_HINTS =
  /(<\/(?:html|body|head)>|gateway|bad gateway|service unavailable|too many requests|{"error"|status_code\s*[:=])/i

const JSON_ERROR_KEYS = new Set(['error', 'errors', 'status_code', 'error_code', 'code'])
const JSON_ERROR_VALUE_HINTS =
  /rate.?limit|too many requests|quota|unauthorized|forbidden|invalid api key|not found|overload|timeout|internal server|bad gateway|service unavailable|exceeded/i

export function isLikelyHtmlErrorPage(text: string) {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > 200_000) {
    return false
  }
  if (HTML_DOCUMENT_PATTERN.test(trimmed)) {
    return true
  }
  // 短且无换行的片段里同时出现标签与错误关键词，也按错误页处理
  return trimmed.length <= 2000 && /<[a-z!][\s\S]*>/i.test(trimmed) && HTML_ERROR_HINTS.test(trimmed)
}

/**
 * 裸 JSON 错误体：能解析成对象且含错误特征键（error/errors/status_code/
 * error_code/code）或字符串值带错误语义。合法摘要是 markdown 文本，
 * 不会整篇是 {"error": ...} 形态，误伤可控。
 */
export function isLikelyJsonErrorBody(text: string) {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || trimmed.length > 2000) {
    return false
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return false
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0) {
    return false
  }
  const hasErrorKey = entries.some(([key]) => JSON_ERROR_KEYS.has(key.toLowerCase()))
  const hasErrorValue = entries.some(([, value]) => typeof value === 'string' && JSON_ERROR_VALUE_HINTS.test(value))
  return hasErrorKey || hasErrorValue
}

/** 摘要正文的最低有效性：非空、非 HTML 错误页、非裸 JSON 错误体 */
export function isValidSummaryText(text: string) {
  const trimmed = text.trim()
  return trimmed.length > 0 && !isLikelyHtmlErrorPage(trimmed) && !isLikelyJsonErrorBody(trimmed)
}
