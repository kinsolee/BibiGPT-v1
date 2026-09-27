import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText } from 'ai'
import {
  isLikelyThinkingModel,
  normalizeBaseUrl,
  resolveModelTarget,
  THINKING_MODEL_MIN_OUTPUT_TOKENS,
} from '~/lib/models/registry'
import { renderSegmentsForPrompt, SegmentIndex } from './segments'

export const ARTIFACTS_PROMPT_VERSION = 'artifacts-v1'

export type RawGeneratedArtifacts = {
  chapters: Array<{ title?: unknown; start?: unknown; end?: unknown; summary?: unknown }>
  highlights: Array<{ text?: unknown; start?: unknown; end?: unknown; note?: unknown }>
  keywords: Array<{ term?: unknown }>
  outline: Array<{ level?: unknown; title?: unknown; start?: unknown; end?: unknown }>
}

function buildArtifactsPrompt(title: string | null, segmentsText: string): string {
  return `You are given a numbered list of subtitle segments from one video, one per line:
[idx] mm:ss text

Generate structured artifacts for this video. Respond with STRICT JSON only (no markdown fences, no commentary) using this schema:
{
  "chapters": [{ "title": string, "start": number, "end": number, "summary": string }],
  "highlights": [{ "text": string, "start": number, "end": number, "note": string }],
  "keywords": [{ "term": string }],
  "outline": [{ "level": number, "title": string, "start": number }]
}

Rules:
- "chapters": divide the WHOLE video into 3-10 chronological chapters; the first chapter MUST start at 0 seconds; "summary" is one short sentence describing that chapter.
- "highlights": up to 10 key moments worth jumping back to; "text" quotes or tightly paraphrases what is actually said at that time.
- "keywords": up to 12 key terms, entities or topics.
- "outline": hierarchical content outline; "level" is 1 for main topics and 2 for sub-points, ordered by time.
- All times are SECONDS taken from the given segment timestamps. Never invent timestamps that do not exist in the input.
- Write titles/summaries/notes in the same language as the subtitles.
- Output JSON only.

Video title: "${(title ?? 'Untitled').replace(/\n+/g, ' ').trim()}"

Segments:
${segmentsText}`
}

function extractJsonObject(text: string): unknown {
  const withoutFences = text
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim()
  const start = withoutFences.indexOf('{')
  const end = withoutFences.lastIndexOf('}')
  if (start === -1 || end <= start) {
    throw new Error('model response does not contain a JSON object')
  }
  return JSON.parse(withoutFences.slice(start, end + 1))
}

export async function generateStructuredArtifacts(input: {
  title: string | null
  segments: SegmentIndex
  model?: string
  baseUrl?: string
  apiKey: string
}): Promise<RawGeneratedArtifacts> {
  const modelTarget = resolveModelTarget({ model: input.model, baseUrl: input.baseUrl })
  const provider = createOpenAICompatible({
    baseURL: normalizeBaseUrl(modelTarget.baseUrl) || 'https://api.openai.com/v1',
    name: modelTarget.provider,
    apiKey: input.apiKey,
  })
  // 思考模型会先消耗推理 token，max_tokens 太小会得到空回复
  const maxOutputTokens = isLikelyThinkingModel(modelTarget.model) ? THINKING_MODEL_MIN_OUTPUT_TOKENS + 2000 : 3000

  const result = await generateText({
    model: provider.chatModel(modelTarget.model),
    prompt: buildArtifactsPrompt(input.title, renderSegmentsForPrompt(input.segments)),
    temperature: 0.2,
    maxOutputTokens,
  })

  const parsed = extractJsonObject(result.text) as Partial<RawGeneratedArtifacts>
  return {
    chapters: Array.isArray(parsed.chapters) ? (parsed.chapters as RawGeneratedArtifacts['chapters']) : [],
    highlights: Array.isArray(parsed.highlights) ? (parsed.highlights as RawGeneratedArtifacts['highlights']) : [],
    keywords: Array.isArray(parsed.keywords) ? (parsed.keywords as RawGeneratedArtifacts['keywords']) : [],
    outline: Array.isArray(parsed.outline) ? (parsed.outline as RawGeneratedArtifacts['outline']) : [],
  }
}
