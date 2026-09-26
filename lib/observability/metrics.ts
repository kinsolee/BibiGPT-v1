import { Redis } from '@upstash/redis'
import { redactSecrets } from '~/lib/models/errors'

/**
 * Provider/cost observability for the summary pipeline (self-hosted edition:
 * token counts and cache behavior only — no credit/billing fields).
 *
 * Every field is redacted before it reaches console or Redis. Provider is only
 * ever recorded as the hashed registry token, never a raw base URL or API key.
 */
export type SummaryMetricEventName =
  | 'cache-hit'
  | 'cache-legacy-hit'
  | 'cache-miss'
  | 'cache-read-failed'
  | 'cache-write'
  | 'cache-skip-invalid'
  | 'cache-purge-invalid'
  | 'cache-write-failed'
  | 'summarize-success'
  | 'summarize-fallback'
  | 'summarize-error'

export interface SummaryMetricEvent {
  event: SummaryMetricEventName
  cacheId: string
  /** Hashed provider token from resolveCacheIdContext, never the raw base URL. */
  provider?: string
  model?: string
  latencyMs?: number
  inputTokens?: number
  outputTokens?: number
  /** Upstream error kind that triggered a non-stream fallback. */
  fallbackFrom?: string
  errorKind?: string
  origin?: 'middleware' | 'handler'
}

const METRICS_REDIS_KEY = 'bibigpt:summary-metrics'
const METRICS_MAX_ENTRIES = 10000

let metricsRedis: Redis | null | undefined

function resolveMetricsRedis(): Redis | null {
  if (metricsRedis !== undefined) {
    return metricsRedis
  }
  try {
    metricsRedis = Redis.fromEnv()
  } catch {
    metricsRedis = null
  }
  return metricsRedis
}

function sanitizeEvent(event: SummaryMetricEvent): SummaryMetricEvent {
  const record = event as unknown as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (typeof record[key] === 'string') {
      record[key] = redactSecrets(record[key] as string)
    }
  }
  return record as unknown as SummaryMetricEvent
}

export function recordSummaryEvent(event: SummaryMetricEvent): void {
  const sanitized = sanitizeEvent(event)
  console.info(`[summary-metrics] ${JSON.stringify(sanitized)}`)

  const redis = resolveMetricsRedis()
  if (!redis) {
    return
  }
  redis
    .pipeline()
    .rpush(METRICS_REDIS_KEY, JSON.stringify({ ...sanitized, ts: new Date().toISOString() }))
    .ltrim(METRICS_REDIS_KEY, -METRICS_MAX_ENTRIES, -1)
    .exec()
    .catch((pipelineError: unknown) =>
      console.warn('[summary-metrics] redis persist failed:', redactSecrets(String(pipelineError))),
    )
}
