// VLM adapter：OpenAI 兼容 chat/completions 多模态调用（server-only）。
// 模型/baseUrl 走 lib/models/registry 的 resolveModelTarget；结构化 JSON 输出
// 由 prompt 约定 + 防御性解析保证（不依赖 response_format，兼容本地网关）。
import { resolveModelTarget } from '~/lib/models/registry'

import { getVisionTimeoutMs } from './config'

export interface FrameVisionResult {
  ocr: string
  description: string
  tags: string[]
}

export interface VlmCallOptions {
  model?: string
  baseUrl?: string
  apiKey?: string
  timeoutMs?: number
  /** 测试注入 fetch；生产用全局 fetch */
  fetchImpl?: typeof fetch
}

const ANALYSIS_INSTRUCTION = [
  '你是视频关键帧分析助手。分析这一帧画面，只输出一个 JSON 对象，不要输出任何其它文字：',
  '{"ocr":"画面中出现的全部文字（无文字则为空字符串）","description":"画面内容描述，一到三句话","tags":["3-8个内容标签"]}',
].join('\n')

const QA_INSTRUCTION = [
  '你是视频关键帧问答助手。基于这一帧画面回答用户问题，只输出一个 JSON 对象，不要输出任何其它文字：',
  '{"answer":"对用户问题的回答"}',
].join('\n')

function buildDataUrl(base64: string, mime: string): string {
  return `data:${mime};base64,${base64}`
}

function extractJson(text: string): Record<string, unknown> {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`VLM 输出不是 JSON：${trimmed.slice(0, 120)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    throw new Error(`VLM 输出 JSON 解析失败：${trimmed.slice(start, Math.min(end + 1, start + 160))}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('VLM 输出的 JSON 不是对象')
  }
  return parsed as Record<string, unknown>
}

async function callVlm(
  image: { base64: string; mime: string },
  instruction: string,
  options: VlmCallOptions,
): Promise<Record<string, unknown>> {
  const target = resolveModelTarget({ model: options.model, baseUrl: options.baseUrl })
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const apiKey = options.apiKey ?? process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.OPENAI_API_KEY ?? ''

  const response = await fetchImpl(`${target.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: target.model,
      messages: [
        { role: 'system', content: '只输出 JSON。' },
        {
          role: 'user',
          content: [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: buildDataUrl(image.base64, image.mime) } },
          ],
        },
      ],
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? getVisionTimeoutMs()),
  })

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '')
    throw new Error(`VLM 请求失败（HTTP ${response.status}）：${bodyText.slice(0, 200)}`)
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>
  }
  const content = payload.choices?.[0]?.message?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
      ? content.map((part) => part.text ?? '').join('')
      : ''
  if (!text.trim()) {
    throw new Error('VLM 返回空内容')
  }
  return extractJson(text)
}

function toText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

/** 单帧分析：OCR + 画面描述 + 标签。抛错由调用方逐帧隔离。 */
export async function analyzeFrameImage(
  image: { base64: string; mime: string },
  options: VlmCallOptions = {},
): Promise<FrameVisionResult> {
  const parsed = await callVlm(image, ANALYSIS_INSTRUCTION, options)
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map((tag) => toText(tag)).filter(Boolean) : []
  return {
    ocr: toText(parsed.ocr),
    description: toText(parsed.description),
    tags: Array.from(new Set(tags)).slice(0, 8),
  }
}

/** 帧 Q&A：基于单帧画面回答任意问题。 */
export async function askFrameQuestion(
  image: { base64: string; mime: string },
  question: string,
  options: VlmCallOptions = {},
): Promise<string> {
  const parsed = await callVlm(image, `${QA_INSTRUCTION}\n用户问题：${question}`, options)
  const answer = toText(parsed.answer)
  if (!answer) {
    throw new Error('VLM 未返回答案')
  }
  return answer
}
