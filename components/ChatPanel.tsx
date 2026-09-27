import { useCallback, useEffect, useRef, useState } from 'react'
import { ChatMessageBubble } from '~/components/chat/ChatMessageBubble'
import { useToast } from '~/hooks/use-toast'
import type { ChatMessageDTO, ChatMessagesResponse } from '~/lib/chat/types'

const PAGE_SIZE = 50

function parseBackendErrorMessage(message: string) {
  const matcher = message.match(/^(\d{3})::([\s\S]*)$/)
  if (!matcher) {
    return { statusCode: 0, detail: message }
  }
  return { statusCode: Number(matcher[1]), detail: matcher[2].trim() }
}

type SendError = {
  question: string
  detail: string
}

/**
 * 视频内 Chat/Ask 面板：对已保存视频多轮追问，回答带 [mm:ss] 可点击引用。
 * 上下文与引用持久化在 conversations/messages 表，刷新后自动恢复；
 * 流式失败时不落库，仅本地展示错误并可重试。
 */
export function ChatPanel({
  videoId,
  service,
  pageNumber,
  model,
  outputLanguage,
  userKey,
  baseUrl,
}: {
  videoId: string
  service: string
  pageNumber: string | null
  model?: string
  outputLanguage?: string
  userKey?: string
  baseUrl?: string
}) {
  const { toast } = useToast()
  const [messages, setMessages] = useState<ChatMessageDTO[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingHistory, setLoadingHistory] = useState(true)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [liveText, setLiveText] = useState<string | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<string | null>(null)
  const [sendError, setSendError] = useState<SendError | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const sourceQuery = useCallback(
    (page = 1) => {
      const params = new URLSearchParams({ service, videoId, page: String(page), pageSize: String(PAGE_SIZE) })
      if (pageNumber) {
        params.set('pageNumber', pageNumber)
      }
      return params.toString()
    },
    [service, videoId, pageNumber],
  )

  const loadMessages = useCallback(
    async (page = 1) => {
      setLoadingHistory(true)
      setHistoryError(null)
      try {
        const response = await fetch(`/api/conversations/messages?${sourceQuery(page)}`)
        if (response.status === 401) {
          setHistoryError('登录后才能查看和继续视频追问')
          setMessages([])
          return
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const data = (await response.json()) as ChatMessagesResponse
        setMessages((previous) => (page === 1 ? data.items : [...data.items, ...previous]))
        setHasMore(data.hasMore)
      } catch (error: any) {
        setHistoryError(error?.message || '加载会话失败')
      } finally {
        setLoadingHistory(false)
      }
    },
    [sourceQuery],
  )

  useEffect(() => {
    if (!videoId) {
      return
    }
    setMessages([])
    setHasMore(false)
    setSendError(null)
    setLiveText(null)
    setPendingQuestion(null)
    loadMessages(1)
    return () => abortRef.current?.abort()
  }, [videoId, service, pageNumber, loadMessages])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [messages.length, liveText])

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim()
      if (!trimmed || streaming) {
        return
      }
      setDraft('')
      setSendError(null)
      setStreaming(true)
      setPendingQuestion(trimmed)
      setLiveText('')

      const controller = new AbortController()
      abortRef.current = controller
      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            chatRequest: { service, videoId, pageNumber, message: trimmed },
            videoConfig: { videoId, service, pageNumber, model },
            userConfig: { userKey, baseUrl, outputLanguage },
          }),
        })
        if (!response.ok || !response.body) {
          const text = await response.text()
          const { statusCode, detail } = parseBackendErrorMessage(text)
          setSendError({
            question: trimmed,
            detail:
              statusCode === 401 ? '登录后才能对视频追问' : statusCode === 404 ? detail : detail || '请求失败，请重试',
          })
          return
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let text = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }
          text += decoder.decode(value, { stream: true })
          setLiveText(text)
        }
        if (!text.trim()) {
          setSendError({ question: trimmed, detail: '回答为空，请重试' })
          return
        }
        // 服务端持久化完成后拉取权威数据（含结构化 citations）
        await loadMessages(1)
      } catch (error: any) {
        if (error?.name !== 'AbortError') {
          setSendError({ question: trimmed, detail: error?.message || '连接中断，请重试' })
        }
      } finally {
        abortRef.current = null
        setStreaming(false)
        setLiveText(null)
        setPendingQuestion(null)
      }
    },
    [streaming, service, videoId, pageNumber, model, userKey, baseUrl, outputLanguage, loadMessages],
  )

  const clearConversation = useCallback(async () => {
    try {
      const response = await fetch(`/api/conversations?${sourceQuery(1)}`, { method: 'DELETE' })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      setMessages([])
      setHasMore(false)
      setSendError(null)
      toast({ description: '会话已清空 🧹' })
    } catch (error: any) {
      toast({ variant: 'destructive', title: '清空失败', description: error?.message })
    }
  }, [sourceQuery, toast])

  const disabled = !videoId || loadingHistory || streaming
  return (
    <div className="mx-auto mt-10 max-w-3xl rounded-xl border-2 bg-white p-4 shadow-md">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-lg font-bold">💬 视频问答</h4>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={clearConversation}
            disabled={streaming}
            className="text-xs text-slate-400 hover:text-slate-600 disabled:opacity-50"
          >
            清空会话
          </button>
        )}
      </div>

      {historyError && <p className="mb-2 text-sm text-amber-600">{historyError}</p>}

      <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
        {hasMore && (
          <button
            type="button"
            onClick={() => loadMessages(Math.ceil(messages.length / PAGE_SIZE) + 1)}
            disabled={loadingHistory}
            className="text-xs text-sky-500 hover:text-sky-600 disabled:opacity-50"
          >
            加载更早消息
          </button>
        )}
        {messages.map((message) => (
          <div key={message.id} className={message.role === 'user' ? 'text-right' : 'text-left'}>
            <div
              className={`inline-block max-w-[90%] rounded-lg px-3 py-2 ${
                message.role === 'user' ? 'bg-sky-500 text-white' : 'bg-slate-100 text-slate-800'
              }`}
            >
              {message.role === 'assistant' ? (
                <ChatMessageBubble
                  content={message.content}
                  citations={message.citations}
                  videoId={videoId}
                  service={service}
                />
              ) : (
                <div className="whitespace-pre-wrap break-words text-sm leading-6">{message.content}</div>
              )}
            </div>
          </div>
        ))}

        {pendingQuestion !== null && (
          <div className="text-right">
            <div className="inline-block max-w-[90%] rounded-lg bg-sky-500 px-3 py-2 text-sm leading-6 text-white">
              {pendingQuestion}
            </div>
          </div>
        )}
        {liveText !== null && (
          <div className="text-left">
            <div className="inline-block max-w-[90%] rounded-lg bg-slate-100 px-3 py-2 text-slate-800">
              <ChatMessageBubble content={liveText} citations={[]} videoId={videoId} service={service} />
            </div>
          </div>
        )}
        {sendError && (
          <div className="text-left">
            <div className="inline-block max-w-[90%] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
              <p>{sendError.detail}</p>
              <button
                type="button"
                onClick={() => send(sendError.question)}
                disabled={streaming}
                className="mt-1 text-xs font-medium text-red-700 underline disabled:opacity-50"
              >
                重试
              </button>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault()
          send(draft)
        }}
        className="mt-3 flex gap-2"
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={disabled}
          placeholder={
            historyError
              ? '登录后可对视频内容追问'
              : streaming
              ? '回答生成中…'
              : '针对这个视频问点什么，例如「视频里提到的关键步骤是什么？」'
          }
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-400 disabled:bg-slate-50"
        />
        <button
          type="submit"
          disabled={disabled || !draft.trim()}
          className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-50"
        >
          {streaming ? '生成中' : '发送'}
        </button>
      </form>
    </div>
  )
}
