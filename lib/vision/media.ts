// 内容解析与本地媒体定位（server-only）。
// 关键帧提取 fail closed：远程来源（YouTube/Bilibili 等）没有本地媒体文件，
// 结构化报错，绝不伪造帧；音频-only 文件显式标注，由调用方决定插图策略。
import type { SupabaseClient } from '@supabase/supabase-js'

import { parseLocalFileId } from '~/lib/sources/adapters/localFile'
import { parseVideoSourceUrl } from '~/lib/sources/registry'
import { SourceError } from '~/lib/sources/types'
import { resolveCompletedUpload } from '~/lib/storage/localStore'
import { probeMedia } from '~/lib/storage/mediaProbe'
import type { ContentRow } from '~/lib/history/types'

export interface ResolvedVisionMedia {
  content: ContentRow
  /** 'video' 可抽关键帧；'audio-only' 无视频轨 */
  mediaKind: 'video' | 'audio-only'
  filePath: string
  fileId: string
  duration: number | null
}

/** videoUrl → 用户自己的 content 行（service/source_ref 口径与来源 adapter 一致） */
export async function resolveVisionContent(
  supabase: SupabaseClient,
  userId: string,
  videoUrl: string,
  pageNumber?: string | null,
): Promise<ContentRow | null> {
  let service: string
  let sourceRef: string
  const url = (() => {
    try {
      return new URL(videoUrl)
    } catch {
      return null
    }
  })()

  const fileId = url ? parseLocalFileId(url) : undefined
  if (url?.protocol === 'bibi-local:' && fileId) {
    service = 'local'
    sourceRef = `local:file:${fileId}`
  } else {
    const parsed = parseVideoSourceUrl(videoUrl)
    if (!parsed) {
      return null
    }
    service = parsed.adapter.id
    sourceRef = parsed.videoId
  }

  const candidates = pageNumber ? [pageNumber, null] : [null]
  for (const sourcePage of candidates) {
    let match = supabase
      .from('contents')
      .select('*')
      .eq('user_id', userId)
      .eq('service', service)
      .eq('source_ref', sourceRef)
    match = sourcePage === null ? match.is('source_page', null) : match.eq('source_page', sourcePage)
    const { data, error } = await match.maybeSingle()
    if (error) {
      throw error
    }
    if (data) {
      return data as ContentRow
    }
  }
  return null
}

/** content → 本地媒体文件；非本地上传来源抛 SOURCE_UNAVAILABLE（fail closed） */
export async function resolveVisionMedia(content: ContentRow): Promise<ResolvedVisionMedia> {
  const url = (() => {
    try {
      return new URL(content.source_url)
    } catch {
      return null
    }
  })()
  const fileId = url ? parseLocalFileId(url) : undefined
  if (url?.protocol !== 'bibi-local:' || !fileId) {
    throw new SourceError(
      'SOURCE_UNAVAILABLE',
      '关键帧提取目前仅支持本地上传的音视频文件（远程平台视频没有本地媒体可抽帧）',
    )
  }
  const resolved = await resolveCompletedUpload(fileId)
  if (!resolved) {
    throw new SourceError('SOURCE_UNAVAILABLE', `本地文件不存在或上传未完成: ${fileId}`)
  }
  const probe = await probeMedia(resolved.path)
  if (probe.ffprobeAvailable && !probe.probeFailed && probe.hasVideo === false) {
    return {
      content,
      mediaKind: 'audio-only',
      filePath: resolved.path,
      fileId,
      duration: probe.duration ?? content.duration ?? null,
    }
  }
  return {
    content,
    mediaKind: 'video',
    filePath: resolved.path,
    fileId,
    duration: probe.duration ?? content.duration ?? null,
  }
}
