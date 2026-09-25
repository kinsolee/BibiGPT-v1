import { createHash } from 'crypto'

import { CacheIdContext, ResolvedModelTarget } from '~/lib/models/types'

export const SUMMARY_CONFIG_VERSION = 'summary-v2'
export const DEFAULT_PROVIDER_ID = 'openai-compatible'
export const DEFAULT_PROVIDER_BASE_URL = 'https://api.openai.com/v1'
export const LEGACY_FALLBACK_MODEL = 'gpt-4o-mini'
// Thinking models spend output budget on reasoning before any visible text;
// small max_tokens makes summaries come back empty.
export const THINKING_MODEL_MIN_OUTPUT_TOKENS = 4000

const THINKING_MODEL_ID_PATTERN = /glm-4\.[5-9]|glm-5|o[134](?:-|$|-mini)|reasoning|thinking/i

export function isLikelyThinkingModel(modelId: string) {
  return THINKING_MODEL_ID_PATTERN.test(modelId)
}

export function normalizeBaseUrl(baseUrl?: string) {
  const value = baseUrl?.trim()
  if (!value) {
    return ''
  }
  if (!/^https?:\/\//.test(value)) {
    throw new Error('baseUrl must start with http:// or https://')
  }
  return value.replace(/\/+$/, '')
}

export function getProviderName() {
  return process.env.OPENAI_COMPATIBLE_PROVIDER_NAME?.trim() || DEFAULT_PROVIDER_ID
}

export function getDefaultModelId() {
  return process.env.OPENAI_COMPATIBLE_MODEL?.trim() || LEGACY_FALLBACK_MODEL
}

export function resolveModelTarget({
  model,
  baseUrl,
}: {
  model?: string
  baseUrl?: string
} = {}): ResolvedModelTarget {
  const requestedModel = model?.trim()
  const resolvedBaseUrl =
    normalizeBaseUrl(baseUrl) || normalizeBaseUrl(process.env.OPENAI_COMPATIBLE_BASE_URL) || DEFAULT_PROVIDER_BASE_URL

  return {
    provider: getProviderName(),
    model: requestedModel || getDefaultModelId(),
    baseUrl: resolvedBaseUrl,
    isDefaultModel: !requestedModel,
  }
}

function cacheProviderToken(provider: string, baseUrl: string) {
  const hash = createHash('sha256').update(`${provider}|${baseUrl}`).digest('hex').slice(0, 8)
  return `${provider}-${hash}`
}

export function resolveCacheIdContext(userConfig?: { baseUrl?: string }): CacheIdContext {
  const target = resolveModelTarget({ baseUrl: userConfig?.baseUrl })
  return {
    provider: cacheProviderToken(target.provider, target.baseUrl),
    promptVersion: SUMMARY_CONFIG_VERSION,
  }
}
