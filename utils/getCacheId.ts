import { VideoConfig } from '~/lib/types'
import { DEFAULT_LANGUAGE } from '~/utils/constants/language'

import { CacheIdContext } from '~/lib/models/types'
import { SUMMARY_CONFIG_VERSION, SUMMARY_TEMPLATE_VERSION } from '~/lib/models/registry'

const UNHASHED_TRANSCRIPT_TOKEN = 'unhashed'

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

function withTranscriptHash(cacheId: string, transcriptHash: string) {
  return cacheId.replace(/-tx-[A-Za-z0-9_]+$/, `-tx-${transcriptHash}`)
}

/**
 * Ordered read candidates for cache-aside lookups: the transcript-hashed key
 * first, then the pre-transcript-hashing key of the SAME version so entries
 * written before that dimension existed keep hitting until their TTL lapses.
 * Pre-version keys (summary-v2 and older) are deliberately excluded — a
 * version bump is the invalidation boundary and old entries are never read or
 * migrated forward.
 */
export function getCacheReadIdCandidates(videoConfig: VideoConfig, context?: CacheIdContext): string[] {
  const primary = getCacheId(videoConfig, context)

  if (!context?.transcriptHash) {
    return [primary]
  }
  return [primary, withTranscriptHash(primary, UNHASHED_TRANSCRIPT_TOKEN)]
}
