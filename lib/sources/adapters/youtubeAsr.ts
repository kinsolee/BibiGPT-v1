import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { transcribeAudioFile, isAsrConfigured } from '~/lib/asr/whisper'

import { createYoutubeAdapter, savesubsProvider } from './youtube'
import type { YoutubeTranscriptProvider, YoutubeTranscriptResult } from './youtube'
import { SourceError } from '../types'

const execFileAsync = promisify(execFile)

export function getYtDlpBin(): string {
  return process.env.BIBI_YTDLP_PATH?.trim() || 'yt-dlp'
}

/**
 * 无字幕 YouTube 的 ASR provider：yt-dlp 抽音轨（含元数据 json）→ Whisper 兼容转写。
 * 失败一律抛 SourceError，绝不伪造 transcript；串在 savesubs 之后，
 * 有字幕时不会触发本 provider（零额外成本），无字幕才走 ASR。
 */
export const youtubeAsrProvider: YoutubeTranscriptProvider = {
  id: 'whisper-asr',
  async fetchTranscript(videoId: string): Promise<YoutubeTranscriptResult | null> {
    if (!isAsrConfigured()) {
      throw new SourceError(
        'NO_TRANSCRIPT',
        `YouTube 视频没有字幕且未配置 ASR（设 BIBI_ASR_API_KEY / BIBI_ASR_BASE_URL 后可用 Whisper 兜底）: ${videoId}`,
      )
    }

    const workDir = path.join(tmpdir(), `bibi-ytasr-${videoId.replace(/[^\w-]/g, '').slice(0, 40)}`)
    await rm(workDir, { recursive: true, force: true })
    await mkdir(workDir, { recursive: true })

    try {
      try {
        await execFileAsync(
          getYtDlpBin(),
          [
            '--no-playlist',
            '-f',
            'bestaudio/best',
            '-x',
            '--audio-format',
            'mp3',
            '--audio-quality',
            '64K',
            '--write-info-json',
            '--no-progress',
            '-o',
            path.join(workDir, 'audio.%(ext)s'),
            `https://www.youtube.com/watch?v=${videoId}`,
          ],
          { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 },
        )
      } catch (error: any) {
        if (error?.code === 'ENOENT') {
          throw new SourceError(
            'NO_TRANSCRIPT',
            `未找到 yt-dlp，无法为无字幕视频抽取音频（BIBI_YTDLP_PATH 可指定路径）: ${videoId}`,
          )
        }
        throw new SourceError(
          'NO_TRANSCRIPT',
          `yt-dlp 抽取音频失败: ${videoId} ${String(error?.message ?? '').slice(0, 200)}`,
        )
      }

      const entries = await readdir(workDir)
      const audioFile = entries.find((name) => /^audio\.(mp3|m4a|webm|opus|ogg)$/.test(name))
      if (!audioFile) {
        throw new SourceError('NO_TRANSCRIPT', `yt-dlp 未产出音频文件: ${videoId}`)
      }

      let title: string | undefined
      let duration: number | undefined
      const infoFile = entries.find((name) => name.endsWith('.info.json'))
      if (infoFile) {
        try {
          const info = JSON.parse(await readFile(path.join(workDir, infoFile), 'utf8'))
          title = typeof info?.title === 'string' ? info.title : undefined
          duration = Number.isFinite(Number(info?.duration)) ? Number(info.duration) : undefined
        } catch {
          // 元数据缺失不影响转写
        }
      }

      const { transcript, language } = await transcribeAudioFile(path.join(workDir, audioFile), {
        filename: `${videoId}.mp3`,
        language: process.env.BIBI_ASR_LANGUAGE?.trim() || undefined,
      })
      return { transcript, language, providerRef: 'yt-dlp+whisper', meta: { title, duration } }
    } finally {
      await rm(workDir, { recursive: true, force: true })
    }
  },
}

/** 无字幕回退链：savesubs 官方/自动字幕优先，全部落空才走 ASR */
export const youtubeAsrAdapter = createYoutubeAdapter([savesubsProvider, youtubeAsrProvider])
