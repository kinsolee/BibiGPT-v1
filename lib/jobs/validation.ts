/**
 * provider 有时会把网关错误页/HTML 以 200 + 文本形式返回。这类内容绝不能
 * 被当作摘要落库或进入 reduce 输入，统一在此识别拦截。
 */
const HTML_DOCUMENT_PATTERN = /^\s*(?:<(!doctype|html|head|body|\?xml|br\s*\/?|center|title)[\s>])/i
const HTML_ERROR_HINTS =
  /(<\/(?:html|body|head)>|gateway|bad gateway|service unavailable|too many requests|{"error"|status_code\s*[:=])/i

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

/** 摘要正文的最低有效性：非空、非错误页、且不是裸报错 JSON */
export function isValidSummaryText(text: string) {
  const trimmed = text.trim()
  return trimmed.length > 0 && !isLikelyHtmlErrorPage(trimmed)
}
