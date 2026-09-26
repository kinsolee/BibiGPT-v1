import { Redis } from '@upstash/redis'
import { CacheIdContext } from '~/lib/models/types'
import { recordSummaryEvent } from '~/lib/observability/metrics'

/**
 * Cache-aside primitives shared by the middleware fast path (proxy.ts) and the
 * handler path (fetchOpenAIResult.ts).
 *
 * New entries are stored as a versioned envelope with an explicit status so a
 * hit can be schema-validated before it is served. Legacy entries (plain text
 * under the pre-KIN-40 key format) stay readable for the migration window.
 * Provider HTML error pages, empty results and half-finished text are never
 * cached and get purged when found.
 */
export const CACHE_ENVELOPE_VERSION = 2
export const DEFAULT_SUMMARY_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60

export interface SummaryCacheEnvelope {
  v: number
  status: 'completed'
  text: string
  /** Hashed provider token from the cache context, never a raw base URL. */
  provider?: string
  model?: string
  templateVersion?: string
  transcriptHash?: string | null
  cachedAt: string
}

export type CacheLookupResult =
  | { kind: 'hit'; text: string; envelope: SummaryCacheEnvelope }
  | { kind: 'legacy-hit'; text: string }
  | { kind: 'miss' }
  | { kind: 'invalid' }

const JSON_ERROR_BODY_PATTERN = /^\s*\{\s*"error"\s*:/

export function looksLikeProviderErrorPage(text: string) {
  const trimmed = text.trim()
  const head = trimmed.slice(0, 200).toLowerCase()
  return (
    /^<!doctype\s+html/.test(head) ||
    /^<html[\s>]/.test(head) ||
    head.includes('<!doctype html') ||
    JSON_ERROR_BODY_PATTERN.test(trimmed)
  )
}

export function isCacheableSummary(text: string) {
  if (!text || !text.trim()) {
    return false
  }
  return !looksLikeProviderErrorPage(text)
}

export function decodeCachedSummary(
  raw: unknown,
): { kind: 'envelope'; envelope: SummaryCacheEnvelope } | { kind: 'plain'; text: string } | { kind: 'invalid' } {
  if (typeof raw === 'string') {
    return isCacheableSummary(raw) ? { kind: 'plain', text: raw } : { kind: 'invalid' }
  }
  if (raw && typeof raw === 'object') {
    const envelope = raw as Partial<SummaryCacheEnvelope>
    if (
      envelope.v === CACHE_ENVELOPE_VERSION &&
      envelope.status === 'completed' &&
      typeof envelope.text === 'string' &&
      isCacheableSummary(envelope.text)
    ) {
      return { kind: 'envelope', envelope: envelope as SummaryCacheEnvelope }
    }
  }
  return { kind: 'invalid' }
}

export async function hashTranscriptInput(transcriptText: string) {
  const data = new TextEncoder().encode(transcriptText)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}

export function buildSummaryCacheEnvelope(params: {
  text: string
  context?: CacheIdContext
  model?: string
  transcriptHash?: string | null
}): SummaryCacheEnvelope {
  const { text, context, model, transcriptHash } = params
  return {
    v: CACHE_ENVELOPE_VERSION,
    status: 'completed',
    text,
    provider: context?.provider,
    model: model || context?.model,
    templateVersion: context?.templateVersion,
    transcriptHash: transcriptHash ?? null,
    cachedAt: new Date().toISOString(),
  }
}

export function resolveSummaryCacheTtlSeconds() {
  const parsed = Number.parseInt(process.env.SUMMARY_CACHE_TTL_SECONDS || '', 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SUMMARY_CACHE_TTL_SECONDS
  }
  return parsed
}

export async function writeSummaryCacheEntry(redis: Redis, cacheId: string, envelope: SummaryCacheEnvelope) {
  if (!isCacheableSummary(envelope.text)) {
    // Errors and half-finished summaries must never pollute the cache.
    recordSummaryEvent({ event: 'cache-skip-invalid', cacheId })
    return false
  }
  try {
    await redis.set(cacheId, JSON.stringify(envelope), { ex: resolveSummaryCacheTtlSeconds() })
    recordSummaryEvent({ event: 'cache-write', cacheId, provider: envelope.provider, model: envelope.model })
    return true
  } catch (writeError) {
    console.warn(`[summary-cache] write failed for ${cacheId}: ${writeError}`)
    recordSummaryEvent({ event: 'cache-write-failed', cacheId })
    return false
  }
}

/**
 * Read candidates in order and validate every hit before serving. Invalid
 * entries are purged so a poisoned value cannot keep getting served.
 */
export async function readValidatedSummary(
  redis: Redis,
  params: {
    cacheId: string
    fallbackIds?: string[]
    origin: 'middleware' | 'handler'
  },
): Promise<CacheLookupResult> {
  const { cacheId, fallbackIds = [], origin } = params
  const candidates = [cacheId, ...fallbackIds]

  for (let index = 0; index < candidates.length; index += 1) {
    const candidateId = candidates[index]
    const raw = await redis.get<unknown>(candidateId)
    if (raw === null || raw === undefined) {
      continue
    }

    const decoded = decodeCachedSummary(raw)
    if (decoded.kind === 'envelope') {
      recordSummaryEvent({
        event: 'cache-hit',
        cacheId: candidateId,
        provider: decoded.envelope.provider,
        model: decoded.envelope.model,
        origin,
      })
      return { kind: 'hit', text: decoded.envelope.text, envelope: decoded.envelope }
    }
    if (decoded.kind === 'plain') {
      recordSummaryEvent({ event: 'cache-legacy-hit', cacheId: candidateId, origin })
      return { kind: 'legacy-hit', text: decoded.text }
    }

    recordSummaryEvent({ event: 'cache-purge-invalid', cacheId: candidateId, origin })
    redis.del(candidateId).catch(() => undefined)
  }

  recordSummaryEvent({ event: 'cache-miss', cacheId, origin })
  return { kind: 'miss' }
}
