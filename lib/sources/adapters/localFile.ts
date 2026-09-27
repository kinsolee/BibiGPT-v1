import { readFile } from 'node:fs/promises'

import { transcribeAudioFile } from '~/lib/asr/whisper'
import { probeMedia } from '~/lib/storage/mediaProbe'
import { buildLocalFileUrl, resolveCompletedUpload } from '~/lib/storage/localStore'

import { parseSubtitleFile } from './subtitleParsers'
import { SourceError } from '../types'
import type { MediaDocument, SourceAdapter } from '../types'

export const LOCAL_FILE_PROTOCOL = 'bibi-local:'

/** `bibi-local:file/up_xxx` → fileId；fileId 格式校验在 storage 层再做一次 */
export function parseLocalFileId(url: URL): string | undefined {
  // 非特殊 scheme 的 URL 没有 authority，pathname 无前导斜杠
  const matched = url.pathname.match(/^\/?file\/(up_[0-9a-z]{24})$/)
  return matched?.[1]
}

export const localFileAdapter: SourceAdapter = {
  id: 'local-file',
  match(url: URL): boolean {
    return url.protocol === LOCAL_FILE_PROTOCOL && Boolean(parseLocalFileId(url))
  },
  async fetch(rawUrl: string): Promise<MediaDocument> {
    const fileId = parseLocalFileId(new URL(rawUrl))
    if (!fileId) {
      throw new SourceError('SOURCE_UNAVAILABLE', `无法从 URL 解析本地文件 fileId: ${rawUrl}`)
    }
    const resolved = await resolveCompletedUpload(fileId)
    if (!resolved) {
      throw new SourceError('SOURCE_UNAVAILABLE', `本地文件不存在或上传未完成: ${fileId}`)
    }
    const { path, meta } = resolved

    if (meta.kind === 'subtitle') {
      const content = await readFile(path, 'utf8')
      const transcript = parseSubtitleFile(meta.filename, content)
      const lastEnd = transcript[transcript.length - 1]?.end
      return {
        sourceRef: `local:file:${fileId}`,
        sourceUrl: buildLocalFileUrl(fileId),
        service: 'local',
        title: meta.filename,
        duration: Number.isFinite(lastEnd) ? lastEnd : undefined,
        transcript,
      }
    }

    // 音频/视频/未知容器：ffprobe 判音轨，无音轨 fail closed，有音轨交给 ASR
    const probe = await probeMedia(path)
    if (probe.ffprobeAvailable && !probe.probeFailed && probe.hasAudio === false) {
      throw new SourceError('NO_TRANSCRIPT', `文件没有音频轨（${meta.filename}），无法生成转写；已阻止生成伪摘要`)
    }

    const {
      transcript,
      language,
      duration: asrDuration,
    } = await transcribeAudioFile(path, {
      filename: meta.filename,
      language: process.env.BIBI_ASR_LANGUAGE?.trim() || undefined,
    })
    return {
      sourceRef: `local:file:${fileId}`,
      sourceUrl: buildLocalFileUrl(fileId),
      service: 'local',
      title: meta.filename,
      duration: probe.duration ?? asrDuration,
      language,
      transcript,
    }
  },
}
