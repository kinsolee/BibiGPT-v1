import { VideoConfig } from '~/lib/types'
import { DEFAULT_LANGUAGE } from '~/utils/constants/language'

import { CacheIdContext } from '~/lib/models/types'
import { SUMMARY_CONFIG_VERSION, SUMMARY_TEMPLATE_VERSION } from '~/lib/models/registry'

const UNHASHED_TRANSCRIPT_TOKEN = 'unhashed'
const LEGACY_PROMPT_VERSION = 'summary-v2'

function normalizeModelId(model?: string) {
  return (model || 'default').replace(/[^\w.-]/g, '_')
}

function configParts(videoConfig: VideoConfig, context?: CacheIdContext) {
  const { showTimestamp, videoId, outputLanguage, detailLevel, model, showEmoji, sentenceNumber, outlineLevel } =
    videoConfig

  return [
    videoId,
    context?.provider || 'default',
    normalizeModelId(model || context?.model),
    outputLanguage || DEFAULT_LANGUAGE,
    showTimestamp ? 'ts' : 'nots',
    showEmoji ? 'emoji' : 'noemoji',
    `s${sentenceNumber || 7}`,
    `o${outlineLevel || 1}`,
    `d${detailLevel ?? 'none'}`,
  ]
}

/**
 * Cache id covers the full summary config: provider/model endpoint, language,
 * timestamp/emoji toggles, bullet count, outline level, detail level, the
 * prompt/config version and the prompt template generation, so switching any of
 * them never reuses another config's cached result. When the caller can supply
 * the transcript input, its hash is part of the key as well.
 */
export function getCacheId(videoConfig: VideoConfig, context?: CacheIdContext) {
  const parts = [
    context?.promptVersion || SUMMARY_CONFIG_VERSION,
    ...configParts(videoConfig, context),
    context?.templateVersion || SUMMARY_TEMPLATE_VERSION,
    `tx-${context?.transcriptHash || UNHASHED_TRANSCRIPT_TOKEN}`,
  ]

  return parts.join('-')
}

/**
 * Pre-KIN-40 key format (config dimensions only, no template/transcript part).
 * Kept solely so recently written entries stay readable during the migration
 * window; new writes never use it.
 */
export function getLegacyCacheId(videoConfig: VideoConfig, context?: CacheIdContext) {
  return [LEGACY_PROMPT_VERSION, ...configParts(videoConfig, context)].join('-')
}

function withTranscriptHash(cacheId: string, transcriptHash: string) {
  return cacheId.replace(/-tx-[A-Za-z0-9_]+$/, `-tx-${transcriptHash}`)
}

/**
 * Ordered read candidates for cache-aside lookups: the full key first, then
 * progressively older formats so entries written before a dimension existed
 * still hit. `getCacheId` itself stays the single write key.
 */
export function getCacheReadIdCandidates(videoConfig: VideoConfig, context?: CacheIdContext): string[] {
  const primary = getCacheId(videoConfig, context)
  const candidates = [primary]

  if (context?.transcriptHash) {
    candidates.push(withTranscriptHash(primary, UNHASHED_TRANSCRIPT_TOKEN))
  }
  candidates.push(getLegacyCacheId(videoConfig, context))

  return candidates
}
