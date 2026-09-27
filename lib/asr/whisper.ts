import { readFile } from 'node:fs/promises'

import { prepareAudioChunks } from './prepare'
import { SourceError } from '~/lib/sources/types'
import type { TranscriptSegment } from '~/lib/sources/types'

const ASR_PLACEHOLDER_KEYS = new Set(['sk-xxx', 'sk-xxx***', 'sk-your-api-key', ''])

export interface AsrConfig {
  baseUrl: string
  apiKey: string
  model: string
  language?: string
}

/** ASR 端点配置：BIBI_ASR_* 优先，回落 OpenAI 兼容配置；没有可用 key 返回 null */
export function resolveAsrConfig(): AsrConfig | null {
  const apiKey = (
    process.env.BIBI_ASR_API_KEY ||
    process.env.OPENAI_COMPATIBLE_API_KEY ||
    process.env.OPENAI_API_KEY
  )?.trim()
  if (!apiKey || ASR_PLACEHOLDER_KEYS.has(apiKey)) {
    return null
  }
  const baseUrl = (
    process.env.BIBI_ASR_BASE_URL ||
    process.env.OPENAI_COMPATIBLE_BASE_URL ||
    'https://api.openai.com/v1'
  )
    .trim()
    .replace(/\/+$/, '')
  const language = process.env.BIBI_ASR_LANGUAGE?.trim()
  return {
    baseUrl,
    apiKey,
    model: process.env.BIBI_ASR_MODEL?.trim() || 'whisper-1',
    language: language || undefined,
  }
}

export function isAsrConfigured(): boolean {
  return resolveAsrConfig() !== null
}

export interface WhisperVerbatimResponse {
  task?: string
  language?: string
  duration?: number
  text?: string
  segments?: Array<{ start?: number; end?: number; text?: string }>
}

export interface TranscribeResult {
  transcript: TranscriptSegment[]
  language?: string
  duration?: number
}

function segmentTimeoutMs(): number {
  const parsed = Number(process.env.BIBI_ASR_TIMEOUT_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60_000
}

async function transcribeSingleChunk(
  config: AsrConfig,
  chunkPath: string,
  offsetSeconds: number,
  filename: string,
): Promise<{ segments: TranscriptSegment[]; language?: string; duration?: number; hasText: boolean }> {
  const bytes = await readFile(chunkPath)
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), filename)
  form.append('model', config.model)
  form.append('response_format', 'verbose_json')
  if (config.language) {
    form.append('language', config.language)
  }

  let response: Response
  try {
    response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(segmentTimeoutMs()),
    })
  } catch (error: any) {
    if (error?.name === 'TimeoutError' || error?.code === 'ABORT_ERR') {
      throw new SourceError('NO_TRANSCRIPT', `ASR 请求超时（${filename}）`)
    }
    throw new SourceError('NO_TRANSCRIPT', `ASR 请求失败：${error?.message ?? 'network error'}（${filename}）`)
  }

  if (!response.ok) {
    const bodySnippet = (await response.text().catch(() => '')).slice(0, 200)
    if (response.status === 429) {
      throw new SourceError('RATE_LIMITED', `ASR 端点限流 (429)：${bodySnippet}`)
    }
    // 4xx/5xx 一律 fail closed：不产出任何 transcript
    throw new SourceError('NO_TRANSCRIPT', `ASR 端点返回 ${response.status}：${bodySnippet || '(no body)'}`)
  }

  let payload: WhisperVerbatimResponse
  try {
    payload = (await response.json()) as WhisperVerbatimResponse
  } catch {
    throw new SourceError('NO_TRANSCRIPT', 'ASR 响应不是合法 JSON')
  }

  const segments: TranscriptSegment[] = []
  if (Array.isArray(payload.segments)) {
    for (const raw of payload.segments) {
      const text = (raw.text ?? '').trim()
      if (!text) {
        continue
      }
      const start = Number(raw.start) || 0
      const end = Number(raw.end)
      segments.push({
        start: offsetSeconds + start,
        end: offsetSeconds + (Number.isFinite(end) && end >= start ? end : start),
        text,
        lang: payload.language,
      })
    }
  }
  if (!segments.length && payload.text?.trim()) {
    // 部分兼容端点只回 text：仍是真实转写输出，包成单段（时长未知时不臆造，end 与 start 相等）
    const duration = Number(payload.duration)
    const end = offsetSeconds + (Number.isFinite(duration) && duration > 0 ? duration : 0)
    segments.push({ start: offsetSeconds, end, text: payload.text.trim(), lang: payload.language })
  }
  return {
    segments,
    language: payload.language,
    duration: Number(payload.duration),
    hasText: segments.length > 0,
  }
}

/** 音频文件 → Whisper 兼容转写。任何失败抛 SourceError（fail closed），绝不返回伪 transcript */
export async function transcribeAudioFile(
  filePath: string,
  options: { filename?: string; language?: string } = {},
): Promise<TranscribeResult> {
  const config = resolveAsrConfig()
  if (!config) {
    throw new SourceError(
      'NO_TRANSCRIPT',
      '未配置 ASR：请在 .env 设置 BIBI_ASR_API_KEY（或 OPENAI_COMPATIBLE_API_KEY）与 BIBI_ASR_BASE_URL / BIBI_ASR_MODEL',
    )
  }

  const filename = options.filename || 'audio.mp3'
  const prepared = await prepareAudioChunks(filePath)
  try {
    const transcript: TranscriptSegment[] = []
    let language: string | undefined
    let totalDuration = 0

    for (const chunk of prepared.chunks) {
      const result = await transcribeSingleChunk(
        { ...config, language: options.language || config.language },
        chunk.path,
        chunk.offsetSeconds,
        filename,
      )
      transcript.push(...result.segments)
      language = result.language || language
      if (result.duration !== undefined && result.duration > 0) {
        totalDuration = Math.max(totalDuration, chunk.offsetSeconds + result.duration)
      }
    }

    if (!transcript.length) {
      throw new SourceError('NO_TRANSCRIPT', 'ASR 端点返回空转写（文件可能没有可识别的语音）')
    }
    return { transcript, language, duration: totalDuration > 0 ? totalDuration : undefined }
  } finally {
    await prepared.cleanup()
  }
}
