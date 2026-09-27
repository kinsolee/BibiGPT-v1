// 内容解析与本地媒体定位（server-only）。
// 关键帧提取 fail closed：远程来源（YouTube/Bilibili 等）没有本地媒体文件，
// 结构化报错，绝不伪造帧；音频-only 文件显式标注，由调用方决定插图策略。
import type { SupabaseClient } from '@supabase/supabase-js'

import { parseLocalFileId } from '~/lib/sources/adapters/localFile'
import { parseVideoSourceUrl } from '~/lib/sources/registry'
import { buildBilibiliSourceRef, buildYoutubeSourceRef } from '~/lib/sources/sourceRef'
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

/**
 * 同一视频在 contents 表里可能有两种 source_ref 口径：
 * - 旧主流程（/api/sumup → persistChatHistory）存裸 videoId（如 `BV1xx`、`dQw4…`）；
 * - KIN-46 ingest 链路（videoId=document.sourceRef）存 canonical 引用
 *   （`youtube:video:<id>`、`bilibili:video:<id>[:pN]`）。
 * 两种都查，B 站分页号同时匹配 source_page 列与 canonical ref 内嵌的 :pN。
 */
function buildSourceRefCandidates(service: string, videoId: string, pageNumber?: string | null): string[] {
  const refs = new Set<string>([videoId])
  if (service === 'youtube') {
    refs.add(buildYoutubeSourceRef(videoId))
  }
  if (service === 'bilibili') {
    refs.add(buildBilibiliSourceRef(videoId))
    if (pageNumber) {
      refs.add(buildBilibiliSourceRef(videoId, pageNumber))
    }
  }
  return Array.from(refs)
}

/** videoUrl → 用户自己的 content 行；兼容裸 videoId 与 canonical sourceRef 两种落库口径 */
export async function resolveVisionContent(
  supabase: SupabaseClient,
  userId: string,
  videoUrl: string,
  pageNumber?: string | null,
): Promise<ContentRow | null> {
  let service: string
  let videoId: string
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
    videoId = fileId
  } else {
    const parsed = parseVideoSourceUrl(videoUrl)
    if (!parsed) {
      return null
    }
    service = parsed.adapter.id
    videoId = parsed.videoId
  }
  const refs = service === 'local' ? [`local:file:${videoId}`] : buildSourceRefCandidates(service, videoId, pageNumber)

  // 分 P：先精确匹配 source_page，再回退 null（ingest 落库的 canonical 行 source_page 为空）
  const pageCandidates = pageNumber ? [pageNumber, null] : [null]
  for (const sourcePage of pageCandidates) {
    let match = supabase
      .from('contents')
      .select('*')
      .eq('user_id', userId)
      .eq('service', service)
      .in('source_ref', refs)
    match = sourcePage === null ? match.is('source_page', null) : match.eq('source_page', sourcePage)
    const { data, error } = await match.limit(1)
    if (error) {
      throw error
    }
    if (data?.length) {
      return data[0] as ContentRow
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
