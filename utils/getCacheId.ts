import { VideoConfig } from '~/lib/types'
import { DEFAULT_LANGUAGE } from '~/utils/constants/language'

import { CacheIdContext } from '~/lib/models/types'

function normalizeModelId(model?: string) {
  return (model || 'default').replace(/[^\w.-]/g, '_')
}

/**
 * Cache id covers the full summary config: provider/model endpoint, language,
 * timestamp/emoji toggles, bullet count, outline level, detail level and the
 * prompt/config version, so switching any of them never reuses another
 * config's cached result.
 */
export function getCacheId(videoConfig: VideoConfig, context?: CacheIdContext) {
  const { showTimestamp, videoId, outputLanguage, detailLevel, model, showEmoji, sentenceNumber, outlineLevel } =
    videoConfig

  const parts = [
    context?.promptVersion || 'summary-v1',
    videoId,
    context?.provider || 'default',
    normalizeModelId(model),
    outputLanguage || DEFAULT_LANGUAGE,
    showTimestamp ? 'ts' : 'nots',
    showEmoji ? 'emoji' : 'noemoji',
    `s${sentenceNumber || 7}`,
    `o${outlineLevel || 1}`,
    `d${detailLevel ?? 'none'}`,
  ]

  return parts.join('-')
}
