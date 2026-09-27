// 关键帧集合生成编排（server-only）：场景检测 → 确定性选帧 → 抽帧 → 落库。
// 音频-only：默认不生成（结构化空结果）；插图开关打开时复用来源自带图片。
import { createHash } from 'crypto'

import type { SupabaseClient } from '@supabase/supabase-js'
import { findExtendedSourceAdapter } from '~/lib/sources/adapters/extendedRegistry'
import { SourceError } from '~/lib/sources/types'
import type { MediaImage } from '~/lib/sources/types'
import type { ContentRow } from '~/lib/history/types'

import { getMaxFrames, getMinGapSeconds, getSceneThreshold, isAudioIllustrationsEnabled } from './config'
import { detectSceneTimes, extractFrameJpegs, readFrameBytes } from './ffmpegScenes'
import { computeKeyframeSetId, selectKeyframes } from './keyframeSelect'
import { assertSafePublicImageUrl } from './urlGuard'
import { resolveVisionMedia } from './media'
import { computeKeyframesInputHash, loadKeyframeArtifact, persistKeyframeSet } from './persist'
import type { KeyframeSetPayload, VisionFrame } from './types'

export type GenerateKeyframesResult =
  | { status: 'ok'; payload: KeyframeSetPayload; reused: boolean; version: number }
  | { status: 'audio-only'; payload: KeyframeSetPayload; reused: boolean; version: number }

/** 音频-only 插图：从来源 MediaDocument.images 取（自用版无图像生成模型，PR 已注明口径） */
async function fetchSourceImages(videoUrl: string): Promise<MediaImage[]> {
  const adapter = findExtendedSourceAdapter(videoUrl)
  if (!adapter) {
    throw new SourceError('SOURCE_UNAVAILABLE', `无法解析来源: ${videoUrl}`)
  }
  const doc = await adapter.fetch(videoUrl)
  return doc.images ?? []
}

function buildIllustrationId(url: string): string {
  return `illu_${createHash('sha1').update(url).digest('hex').slice(0, 12)}`
}

/** 图文笔记/插图的稳定图片 ID（sha1(url)），imageId → 已落库 URL 的定位键 */
export function illustrationIdFor(url: string): string {
  return buildIllustrationId(url)
}

export async function generateKeyframeSet(params: {
  supabase: SupabaseClient
  userId: string
  content: ContentRow
  videoUrl: string
  force?: boolean
}): Promise<GenerateKeyframesResult> {
  const { supabase, userId, content } = params
  const media = await resolveVisionMedia(content)
  const threshold = getSceneThreshold()
  const maxFrames = getMaxFrames()
  const minGapSeconds = getMinGapSeconds()
  const sourceRef = content.source_ref

  if (media.mediaKind === 'audio-only') {
    if (!isAudioIllustrationsEnabled()) {
      return {
        status: 'audio-only',
        reused: false,
        version: 0,
        payload: {
          setId: computeKeyframeSetId({ sourceRef, threshold, maxFrames, minGapSeconds, duration: media.duration }),
          mode: 'audio-only',
          threshold,
          source: { service: content.service, sourceRef, duration: media.duration },
          frames: [],
          sceneCount: 0,
          illustrations: [],
          generatedAt: new Date().toISOString(),
        },
      }
    }
    // 插图开关打开：音频-only 笔记复用来源自带图片作为插图
    const images = await fetchSourceImages(params.videoUrl)
    const payload: KeyframeSetPayload = {
      setId: computeKeyframeSetId({ sourceRef, threshold, maxFrames, minGapSeconds, duration: media.duration }),
      mode: 'audio-illustrations',
      threshold,
      source: { service: content.service, sourceRef, duration: media.duration },
      frames: [],
      sceneCount: 0,
      illustrations: images.map((image) => ({ id: buildIllustrationId(image.url), url: image.url, alt: image.alt })),
      generatedAt: new Date().toISOString(),
    }
    const inputHash = await computeKeyframesInputHash({
      sourceRef,
      threshold,
      maxFrames,
      minGapSeconds,
      duration: media.duration,
    })
    const persisted = await persistKeyframeSet({
      supabase,
      userId,
      contentId: content.id,
      summaryId: null,
      payload,
      refs: { inputHash, setId: payload.setId, sourceRef, threshold },
      force: params.force,
    })
    return { status: 'audio-only', payload, reused: persisted.reused, version: persisted.version }
  }

  const detection = await detectSceneTimes(media.filePath, threshold)
  const setId = computeKeyframeSetId({
    sourceRef,
    threshold,
    maxFrames,
    minGapSeconds,
    duration: detection.duration,
  })
  const selected = selectKeyframes(
    { sceneTimes: detection.times, duration: detection.duration, maxFrames, minGapSeconds },
    setId,
  )
  const extracted = await extractFrameJpegs(
    media.filePath,
    selected.map((frame) => frame.time),
    setId,
  )

  const frames: VisionFrame[] = selected.map((frame, idx) => ({
    id: frame.id,
    idx,
    time: extracted[idx]?.time ?? frame.time,
    file: extracted[idx]?.file ?? `frame-${String(idx).padStart(3, '0')}.jpg`,
  }))

  console.debug(
    `[vision] keyframes: content=${content.id} frames=${frames.length} sceneCandidates=${
      detection.times.length
    } durationSec=${detection.duration ?? 'unknown'}`,
  )

  const payload: KeyframeSetPayload = {
    setId,
    mode: 'video',
    threshold,
    source: { service: content.service, sourceRef, duration: detection.duration },
    frames,
    sceneCount: detection.times.length,
    illustrations: [],
    generatedAt: new Date().toISOString(),
  }
  const inputHash = await computeKeyframesInputHash({
    sourceRef,
    threshold,
    maxFrames,
    minGapSeconds,
    duration: detection.duration,
  })
  const persisted = await persistKeyframeSet({
    supabase,
    userId,
    contentId: content.id,
    summaryId: null,
    payload,
    refs: { inputHash, setId, sourceRef, threshold },
    force: params.force,
  })
  if (persisted.reused && !params.force) {
    // 幂等命中：读回已落库 payload，保证重复请求返回同一集合
    const existing = await loadKeyframeArtifact(supabase, content.id)
    if (existing) {
      return {
        status: 'ok',
        payload: existing.payload as unknown as KeyframeSetPayload,
        reused: true,
        version: existing.version,
      }
    }
  }
  return { status: 'ok', payload, reused: persisted.reused, version: persisted.version }
}

/** 读取帧图片字节并计算内容 hash（缓存键）；插图走 URL 下载，关键帧走磁盘 */
export async function loadFrameImage(
  frame: {
    setId: string | null
    file?: string
    url?: string
  },
  options?: { fetchImpl?: typeof fetch },
): Promise<{ base64: string; mime: string; frameHash: string }> {
  let bytes: Buffer
  let mime = 'image/jpeg'
  if (frame.setId && frame.file) {
    bytes = await readFrameBytes(frame.setId, frame.file)
  } else if (frame.url) {
    // P1-1：URL 只能来自服务端落库数据，且必须通过公网 http(s) 守卫
    assertSafePublicImageUrl(frame.url)
    const fetchImpl = options?.fetchImpl ?? globalThis.fetch
    const response = await fetchImpl(frame.url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) {
      throw new SourceError('SOURCE_UNAVAILABLE', `插图下载失败（HTTP ${response.status}）: ${frame.url}`)
    }
    // P2-4：保留真实图片 MIME（PNG/WebP 等），缺失或非 image/* 时安全回退 JPEG
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (contentType && /^image\//.test(contentType)) {
      mime = contentType
    }
    bytes = Buffer.from(await response.arrayBuffer())
  } else {
    throw new SourceError('SOURCE_UNAVAILABLE', '帧引用缺少文件或 URL')
  }
  const frameHash = createHash('sha256').update(bytes).digest('hex')
  return { base64: bytes.toString('base64'), mime, frameHash }
}
