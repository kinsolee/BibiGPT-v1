// 图文笔记图片获取（server-only）：优先来源 adapter 实时拉取，
// 成功后写 image_note_images artifact 缓存；来源失败时回退缓存，
// 保证图文笔记「重新打开仍显示原图」。
import type { SupabaseClient } from '@supabase/supabase-js'
import { findExtendedSourceAdapter } from '~/lib/sources/adapters/extendedRegistry'
import { findSourceAdapter } from '~/lib/sources/registry'
import { SourceError } from '~/lib/sources/types'
import type { MediaImage, SourceAdapter } from '~/lib/sources/types'
import type { ContentRow } from '~/lib/history/types'

import { computeImageNoteInputHash, loadImageNoteArtifact, persistImageNoteCache } from './persist'
import type { ImageNotePayload } from './types'

/**
 * P1-2：图片拉取只用轻量 metadata 路径。YouTube/Bilibili 走客户端安全
 * registry（封面来自 oembed/view 接口）；扩展面只保留 podcast（RSS）与
 * 社媒骨架（fail fast），显式排除 whisper-asr / local-file 两个重型
 * adapter——它们的 fetch 无字幕时会触发 yt-dlp + Whisper 全管线。
 * HEAVY_ADAPTER_IDS 里的 id 永不进入图片拉取。
 */
const HEAVY_ADAPTER_IDS = new Set(['whisper-asr', 'local-file'])

function findLightweightImageAdapter(rawUrl: string): SourceAdapter | undefined {
  const lightweight = findSourceAdapter(rawUrl)
  if (lightweight) {
    return lightweight
  }
  const extended = findExtendedSourceAdapter(rawUrl)
  return extended && !HEAVY_ADAPTER_IDS.has(extended.id) ? extended : undefined
}

export type FetchImagesResult =
  | { status: 'live' | 'cache'; contentId: string; images: MediaImage[]; service: string; sourceRef: string }
  | { status: 'unavailable'; contentId: string | null; reason: string }

export async function fetchImageNoteImages(params: {
  supabase: SupabaseClient
  userId: string
  videoUrl: string
  content: ContentRow | null
}): Promise<FetchImagesResult> {
  const contentId = params.content?.id ?? null
  const sourceRef = params.content?.source_ref ?? params.videoUrl
  const service = params.content?.service ?? 'unknown'

  try {
    const adapter = findLightweightImageAdapter(params.videoUrl)
    if (!adapter) {
      throw new SourceError('SOURCE_UNAVAILABLE', `无法解析来源: ${params.videoUrl}`)
    }
    const doc = await adapter.fetch(params.videoUrl)
    const images = doc.images ?? []
    if (!images.length) {
      throw new SourceError('NO_TRANSCRIPT', '该来源没有可展示的图片（非图文笔记内容）')
    }
    if (contentId) {
      try {
        const inputHash = await computeImageNoteInputHash({
          sourceRef,
          urls: images.map((image) => image.url),
        })
        await persistImageNoteCache({
          supabase: params.supabase,
          userId: params.userId,
          contentId,
          payload: {
            sourceRef,
            service: doc.service,
            title: doc.title,
            images: images.map((image) => ({ url: image.url, alt: image.alt })),
            fetchedAt: new Date().toISOString(),
          },
          refs: { inputHash, sourceRef },
        })
      } catch (cacheError) {
        // 缓存写失败不影响实时结果
        console.warn(
          `[vision] image note cache write failed: ${cacheError instanceof Error ? cacheError.message : cacheError}`,
        )
      }
    }
    return { status: 'live', contentId: contentId ?? '', images, service: doc.service, sourceRef: doc.sourceRef }
  } catch (error) {
    const reason =
      error instanceof SourceError ? error.message : error instanceof Error ? error.message : '来源拉取失败'
    if (contentId) {
      try {
        const cached = await loadImageNoteArtifact(params.supabase, contentId)
        const payload = cached?.payload as unknown as ImageNotePayload | undefined
        if (payload?.images?.length) {
          return {
            status: 'cache',
            contentId,
            images: payload.images.map((image) => ({ url: image.url, alt: image.alt })),
            service: payload.service ?? service,
            sourceRef: payload.sourceRef ?? sourceRef,
          }
        }
      } catch (cacheError) {
        console.warn(
          `[vision] image note cache read failed: ${cacheError instanceof Error ? cacheError.message : cacheError}`,
        )
      }
    }
    return { status: 'unavailable', contentId, reason }
  }
}
