import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchOpenAIResult } from '~/lib/openai/fetchOpenAIResult'
import { selectApiKeyAndActivatedLicenseKey } from '~/lib/openai/selectApiKeyAndActivatedLicenseKey'
import { isLikelyThinkingModel, resolveModelTarget, THINKING_MODEL_MIN_OUTPUT_TOKENS } from '~/lib/models/registry'
import { buildChatMessages } from '~/lib/chat/prompt'
import { extractStampTokens } from '~/lib/chat/format'
import { selectContextWindow, loadTranscriptSegments } from '~/lib/chat/retrieval'
import type { RetrievedSegment } from '~/lib/chat/retrieval'
import { appendExchange, ensureConversation, listRecentMessages, resolveContent } from '~/lib/chat/store'
import { CHAT_HISTORY_MESSAGE_LIMIT } from '~/lib/chat/types'
import type { ChatSourceKey, Citation } from '~/lib/chat/types'
import type { VideoConfig } from '~/lib/types'

export class ChatAskError extends Error {
  statusCode: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'ChatAskError'
    this.statusCode = statusCode
  }
}

const CHAT_MAX_TOKENS = 1200
/** 时间戳解析不到精确落点时，允许回退到最近的 segment（秒） */
const CITATION_TIME_TOLERANCE_SECONDS = 3
const MAX_CITATIONS = 10
const CITATION_SNIPPET_LENGTH = 120

export type PreparedChatAsk = {
  conversationId: string
  streamResult: ReadableStream | string
  /** 流式完整结束后调用；把 user/assistant 消息与结构化引用一起落库 */
  persist: (finalText: string) => Promise<void>
}

/**
 * 视频内追问准备阶段：鉴权由调用方完成（需要在 res 写 cookie），
 * 这里负责定位内容、检索字幕窗口、组装多轮上下文并发起流式模型调用。
 * 持久化延迟到流式完整成功之后（persist 回调），失败路径不留半截数据。
 */
export async function prepareChatAsk(params: {
  supabase: SupabaseClient
  userId: string
  source: ChatSourceKey
  question: string
  videoConfig?: Partial<VideoConfig>
  userConfig?: { userKey?: string; baseUrl?: string; outputLanguage?: string }
}): Promise<PreparedChatAsk> {
  const { supabase, userId, source, question, videoConfig, userConfig } = params

  const content = await resolveContent(supabase, userId, source)
  if (!content) {
    throw new ChatAskError(404, '该视频还没有保存过摘要，请先生成一次摘要再追问')
  }

  const segments = await loadTranscriptSegments(supabase, content.id)
  if (segments.length === 0) {
    throw new ChatAskError(404, '该视频没有已保存的字幕，无法回答')
  }

  const conversation = await ensureConversation(supabase, userId, content.id)
  const history = await listRecentMessages(supabase, conversation.id, CHAT_HISTORY_MESSAGE_LIMIT)
  const window = selectContextWindow(question, segments)

  const modelTarget = resolveModelTarget({ model: videoConfig?.model, baseUrl: userConfig?.baseUrl })
  const maxTokens = isLikelyThinkingModel(modelTarget.model)
    ? Math.max(CHAT_MAX_TOKENS, THINKING_MODEL_MIN_OUTPUT_TOKENS)
    : CHAT_MAX_TOKENS
  const apiKey = await selectApiKeyAndActivatedLicenseKey(userConfig?.userKey, source.videoId)

  const messages = buildChatMessages({
    question,
    history,
    segments: window,
    outputLanguage: userConfig?.outputLanguage,
  })
  const cacheVideoConfig: VideoConfig = {
    videoId: source.videoId,
    service: source.service as VideoConfig['service'],
    pageNumber: source.pageNumber,
    model: videoConfig?.model,
    outputLanguage: userConfig?.outputLanguage,
  }
  const streamResult = await fetchOpenAIResult(
    { model: modelTarget.model, messages, max_tokens: maxTokens, stream: true },
    apiKey,
    cacheVideoConfig,
    modelTarget.baseUrl,
  )

  return {
    conversationId: conversation.id,
    streamResult,
    persist: async (finalText: string) => {
      const citations = resolveCitations(finalText, segments)
      await appendExchange(supabase, userId, conversation.id, question, finalText, citations)
    },
  }
}

/** 把回答正文中的 [mm:ss] 标记解析回真实 transcript_segment 行；解析失败的标记不产生引用 */
export function resolveCitations(answer: string, segments: RetrievedSegment[]): Citation[] {
  if (segments.length === 0) {
    return []
  }
  const timed = segments.map((segment) => ({ segment, start: segment.start ?? 0 })).sort((a, b) => a.start - b.start)
  const citations: Citation[] = []
  const seen = new Set<string>()
  for (const { seconds } of extractStampTokens(answer)) {
    const matched = findSegmentAt(timed, seconds)
    if (!matched || seen.has(matched.id)) {
      continue
    }
    seen.add(matched.id)
    citations.push({
      segmentId: matched.id,
      start: matched.start ?? 0,
      end: matched.end,
      text: matched.text.slice(0, CITATION_SNIPPET_LENGTH),
    })
    if (citations.length >= MAX_CITATIONS) {
      break
    }
  }
  return citations
}

function findSegmentAt(
  timed: Array<{ segment: RetrievedSegment; start: number }>,
  seconds: number,
): RetrievedSegment | null {
  for (const { segment, start } of timed) {
    const end = segment.end ?? Number.POSITIVE_INFINITY
    if (seconds >= start && seconds < end) {
      return segment
    }
  }
  let nearest: { segment: RetrievedSegment; distance: number } | null = null
  for (const { segment, start } of timed) {
    const distance = Math.abs(start - seconds)
    if (!nearest || distance < nearest.distance) {
      nearest = { segment, distance }
    }
  }
  return nearest && nearest.distance <= CITATION_TIME_TOLERANCE_SECONDS ? nearest.segment : null
}
