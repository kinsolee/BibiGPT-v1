import { findSourceAdapter } from './sources/registry'
import { transcriptToPlainTextItems, transcriptToSubtitleItems } from './sources/toSubtitleItems'
import { SourceError } from './sources/types'
import type { BilibiliMediaDocument, MediaDocument } from './sources/types'
import { CommonSubtitleItem, VideoConfig, VideoService } from './types'

export interface SubtitleFetchResult {
  title: string
  subtitlesArray?: null | Array<CommonSubtitleItem>
  descriptionText?: string
}

function buildSourceUrl(videoConfig: VideoConfig): string {
  const { service, videoId, pageNumber } = videoConfig
  if (service === VideoService.Youtube) {
    return `https://www.youtube.com/watch?v=${videoId}`
  }
  return `https://www.bilibili.com/video/${videoId}${pageNumber ? `?p=${pageNumber}` : ''}`
}

function toLegacyResult(
  document: MediaDocument,
  videoConfig: VideoConfig,
  shouldShowTimestamp?: boolean,
): SubtitleFetchResult {
  const subtitlesArray = document.transcript.length
    ? videoConfig.service === VideoService.Youtube && !shouldShowTimestamp
      ? transcriptToPlainTextItems(document.transcript)
      : transcriptToSubtitleItems(document.transcript, shouldShowTimestamp)
    : null
  const descriptionText = (document as BilibiliMediaDocument).descriptionText
  return { title: document.title, subtitlesArray, descriptionText }
}

export async function fetchSubtitle(
  videoConfig: VideoConfig,
  shouldShowTimestamp?: boolean,
): Promise<SubtitleFetchResult> {
  console.log('video: ', videoConfig)
  const sourceUrl = buildSourceUrl(videoConfig)
  const adapter = findSourceAdapter(sourceUrl)
  if (!adapter) {
    return { title: '', subtitlesArray: null }
  }

  try {
    const document = await adapter.fetch(sourceUrl)
    return toLegacyResult(document, videoConfig, shouldShowTimestamp)
  } catch (error) {
    // NO_TRANSCRIPT 保持旧行为：返回空字幕，由上层抛 501「No subtitle in the video」
    if (error instanceof SourceError && error.code === 'NO_TRANSCRIPT') {
      return { title: '', subtitlesArray: null }
    }
    throw error
  }
}
