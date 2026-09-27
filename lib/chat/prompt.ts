import { ChatGPTAgent, ChatGPTMessage } from '~/lib/openai/fetchOpenAIResult'
import { NO_EVIDENCE_REPLY } from '~/lib/chat/types'
import { formatStamp } from '~/lib/chat/format'
import type { RetrievedSegment } from '~/lib/chat/retrieval'

const SOURCE_BLOCK_HEADER = '以下是视频字幕片段，每行开头的 [时间] 是该片段的起始时间戳：'

export function buildChatSystemPrompt(outputLanguage?: string): string {
  const language = outputLanguage?.trim() || '中文'
  return [
    '你是视频内容问答助手，只能依据用户提供的字幕片段和之前的对话历史回答问题。',
    '规则：',
    `1. 回答中每个关键论断之后必须紧跟引用标记，格式固定为 [mm:ss]（超过 1 小时用 [h:mm:ss]）；时间戳必须原样取自字幕片段行首的时间，禁止编造或推算新的时间。`,
    `2. 结合对话历史理解用户追问中的指代（如「上面提到的第一个要点」）；涉及新事实的论断仍需字幕片段作为依据。`,
    `3. 仅当字幕片段与对话历史都无法支撑回答时，必须只回复这句话：「${NO_EVIDENCE_REPLY}」不要猜测，不要使用资料之外的知识。`,
    `4. 用${language}回答，简洁直接，不要输出与回答无关的内容。`,
  ].join('\n')
}

export function buildContextBlock(segments: RetrievedSegment[]): string {
  const lines = segments.map((segment) => {
    const start = segment.start ?? 0
    const stamp = formatStamp(start)
    return `[${stamp}] ${segment.text}`
  })
  return `${SOURCE_BLOCK_HEADER}\n${lines.join('\n')}`
}

/**
 * 组装多轮问答的模型输入：
 * system 规则 → user 字幕资料 → assistant 确认 → 最近几轮历史 → 本轮问题。
 * 历史来自持久化 messages，保证刷新后上下文可恢复。
 */
export function buildChatMessages(params: {
  question: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  segments: RetrievedSegment[]
  outputLanguage?: string
}): ChatGPTMessage[] {
  const { question, history, segments, outputLanguage } = params
  const messages: ChatGPTMessage[] = [
    { role: ChatGPTAgent.system, content: buildChatSystemPrompt(outputLanguage) },
    { role: ChatGPTAgent.user, content: buildContextBlock(segments) },
    {
      role: ChatGPTAgent.assistant,
      content: '收到，我会结合对话历史理解追问，只依据以上字幕片段回答，并使用 [mm:ss] 标注引用。',
    },
  ]
  for (const item of history) {
    messages.push({
      role: item.role === 'user' ? ChatGPTAgent.user : ChatGPTAgent.assistant,
      content: item.content,
    })
  }
  messages.push({ role: ChatGPTAgent.user, content: question })
  return messages
}
