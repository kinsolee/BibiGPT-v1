import type { Citation } from '~/lib/chat/types'
import { buildVideoTimestampUrl, extractStampTokens } from '~/lib/chat/format'

const TIMESTAMP_TOKEN_PATTERN = /\[(\d{1,3}:[0-5]?\d(?::[0-5]?\d)?)\]/g

/**
 * 消息气泡：正文里的 [mm:ss] 标记渲染为可点击引用，
 * 点击复用 Sentence.tsx 的跳转行为——新标签页打开视频对应时间点；
 * 服务端解析出的 citations 保证标记对应真实 transcript_segment。
 */
export function ChatMessageBubble({
  content,
  citations,
  videoId,
  service,
}: {
  content: string
  citations: Citation[]
  videoId: string
  service: string
}) {
  const citationBySeconds = new Map<number, Citation>()
  for (const citation of citations ?? []) {
    if (!citationBySeconds.has(citation.start)) {
      citationBySeconds.set(citation.start, citation)
    }
  }

  const parts: Array<{ type: 'text' | 'stamp'; value: string; seconds?: number }> = []
  let lastIndex = 0
  for (const match of Array.from(content.matchAll(TIMESTAMP_TOKEN_PATTERN))) {
    const index = match.index ?? 0
    if (index > lastIndex) {
      parts.push({ type: 'text', value: content.slice(lastIndex, index) })
    }
    const seconds = extractStampTokens(match[0])[0]?.seconds
    parts.push({ type: 'stamp', value: match[0], seconds })
    lastIndex = index + match[0].length
  }
  if (lastIndex < content.length) {
    parts.push({ type: 'text', value: content.slice(lastIndex) })
  }

  return (
    <div className="whitespace-pre-wrap break-words text-sm leading-6">
      {parts.map((part, index) => {
        if (part.type !== 'stamp' || part.seconds === undefined) {
          return <span key={index}>{part.value}</span>
        }
        const citation = citationBySeconds.get(part.seconds)
        const title = citation
          ? `跳到 ${Math.floor(part.seconds)}s · ${citation.text}`
          : `跳到 ${Math.floor(part.seconds)}s`
        return (
          <a
            key={index}
            href={buildVideoTimestampUrl(videoId, service, part.seconds)}
            target="_blank"
            rel="noopener noreferrer"
            title={title}
            className="mx-0.5 inline-flex items-center rounded bg-sky-50 px-1.5 py-0 align-middle text-xs font-medium text-sky-600 hover:bg-sky-100 hover:text-sky-700"
          >
            {part.value}
          </a>
        )
      })}
    </div>
  )
}
