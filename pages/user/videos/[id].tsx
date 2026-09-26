import { useUser } from '@supabase/auth-helpers-react'
import { useRouter } from 'next/router'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { Sidebar } from '~/components/sidebar'
import { SummaryResult } from '~/components/SummaryResult'
import { useToast } from '~/hooks/use-toast'
import {
  deleteHistoryItem,
  fetchHistoryDetail,
  HistoryApiError,
  regenerateHistorySummary,
  toggleHistoryFavorite,
} from '~/hooks/useHistory'
import { HistoryDetailDTO } from '~/lib/history/types'

function formatSeconds(seconds: number | null) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return ''
  }
  const total = Math.floor(seconds)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function HistoryDetailPage() {
  const router = useRouter()
  const { id } = router.query
  const user = useUser()
  const { toast } = useToast()
  const [detail, setDetail] = useState<HistoryDetailDTO | null>(null)
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [regenerating, setRegenerating] = useState(false)

  const load = useCallback(
    async (summaryId?: string | null, options?: { silent?: boolean }) => {
      if (typeof id !== 'string' || !id) {
        return
      }
      if (!options?.silent) {
        setLoading(true)
        setError(null)
      }
      try {
        // 传 summaryId 时服务端返回该版本的摘要与对应 transcript（不传则默认最新版本）
        const result = await fetchHistoryDetail(id, summaryId ?? undefined)
        setDetail(result)
        setSelectedVersion(result.content.summary?.version ?? null)
      } catch (e) {
        setError(e instanceof HistoryApiError && e.status === 401 ? '请先登录后查看历史记录' : (e as Error).message)
        setDetail(null)
      } finally {
        if (!options?.silent) {
          setLoading(false)
        }
      }
    },
    [id],
  )

  useEffect(() => {
    if (user && router.isReady) {
      load()
    }
  }, [user, router.isReady, load])

  const selectedSummary =
    detail?.summaries.find((summary) => summary.version === selectedVersion) ?? detail?.summaries[0] ?? null

  const switchVersion = (summaryId: string, version: number) => {
    setSelectedVersion(version)
    load(summaryId, { silent: true })
  }

  const handleRegenerate = async () => {
    if (!detail || regenerating) {
      return
    }
    setRegenerating(true)
    try {
      const result = await regenerateHistorySummary(detail.content.id)
      toast({ description: result.note })
      await load()
    } catch (e) {
      toast({ variant: 'destructive', title: '重新生成失败', description: (e as Error).message })
    } finally {
      setRegenerating(false)
    }
  }

  const handleFavorite = async () => {
    if (!detail) {
      return
    }
    try {
      const result = await toggleHistoryFavorite(detail.content.id)
      setDetail((prev) => (prev ? { ...prev, content: { ...prev.content, isFavorite: result.isFavorite } } : prev))
    } catch (e) {
      toast({ variant: 'destructive', title: '收藏失败', description: (e as Error).message })
    }
  }

  const handleDelete = async () => {
    if (!detail) {
      return
    }
    if (!window.confirm(`确定删除「${detail.content.title || detail.content.sourceRef}」的全部历史记录吗？`)) {
      return
    }
    try {
      await deleteHistoryItem(detail.content.id)
      toast({ description: '已删除' })
      router.push('/user/videos')
    } catch (e) {
      toast({ variant: 'destructive', title: '删除失败', description: (e as Error).message })
    }
  }

  return (
    <>
      <Sidebar />
      <div className="p-4 sm:ml-64">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Link href="/user/videos" className="text-sm text-slate-500 hover:underline dark:text-slate-400">
              ← 返回历史列表
            </Link>
            <h1 className="mt-1 truncate text-2xl font-bold">
              {detail?.content.title || detail?.content.sourceRef || '历史详情'}
            </h1>
            {detail && (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">{detail.content.service}</span>
                {detail.content.sourcePage && <span>P{detail.content.sourcePage}</span>}
                <span>
                  {detail.summaries.length} 个版本 · 转录 {detail.transcript?.segmentCount ?? 0} 段
                </span>
              </div>
            )}
          </div>
          {detail && (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <button
                type="button"
                onClick={handleFavorite}
                className={detail.content.isFavorite ? 'text-yellow-500' : 'text-slate-400 hover:text-yellow-500'}
              >
                {detail.content.isFavorite ? '★ 已收藏' : '☆ 收藏'}
              </button>
              <button
                type="button"
                onClick={handleRegenerate}
                disabled={regenerating}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-200 dark:text-slate-900"
              >
                {regenerating ? '生成中…' : '重新生成'}
              </button>
              <button type="button" onClick={handleDelete} className="text-red-500 hover:underline">
                删除
              </button>
            </div>
          )}
        </div>

        {!user ? (
          <p className="text-slate-500">登录后即可查看你的总结历史。</p>
        ) : loading ? (
          <p className="text-slate-500">加载中…</p>
        ) : error ? (
          <p className="text-red-500">{error}</p>
        ) : !detail ? (
          <p className="text-slate-500">未找到该记录。</p>
        ) : (
          <>
            {detail.summaries.length > 1 && (
              <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-slate-500 dark:text-slate-400">版本：</span>
                {detail.summaries.map((summary) => (
                  <button
                    key={summary.id}
                    type="button"
                    onClick={() => switchVersion(summary.id, summary.version)}
                    className={`rounded-lg border px-2.5 py-1 ${
                      summary.version === selectedVersion
                        ? 'border-pink-500 text-pink-600 dark:text-pink-400'
                        : 'border-slate-200 hover:border-slate-400 dark:border-slate-700'
                    }`}
                  >
                    v{summary.version}
                  </button>
                ))}
              </div>
            )}

            {selectedSummary?.contentText ? (
              <SummaryResult
                summary={selectedSummary.contentText}
                currentVideoUrl={detail.content.sourceUrl}
                currentVideoId={detail.content.sourceRef}
                shouldShowTimestamp={Boolean(selectedSummary.config.showTimestamp)}
              />
            ) : (
              <p className="text-slate-500">该版本没有摘要内容。</p>
            )}

            {detail.chapters.length > 0 && (
              <section className="mt-8">
                <h2 className="mb-2 text-lg font-bold">章节</h2>
                <ul className="space-y-1 text-sm">
                  {detail.chapters.map((chapter) => (
                    <li key={chapter.idx} className="flex gap-2">
                      <span className="shrink-0 text-slate-500 dark:text-slate-400">
                        {formatSeconds(chapter.start)}
                        {chapter.end !== null ? ` - ${formatSeconds(chapter.end)}` : ''}
                      </span>
                      <span className="font-medium">{chapter.title}</span>
                      {chapter.summary && <span className="text-slate-500 dark:text-slate-400">{chapter.summary}</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {detail.highlights.length > 0 && (
              <section className="mt-8">
                <h2 className="mb-2 text-lg font-bold">高亮</h2>
                <ul className="space-y-1 text-sm">
                  {detail.highlights.map((highlight) => (
                    <li key={highlight.idx} className="flex gap-2">
                      <span className="shrink-0 text-slate-500 dark:text-slate-400">
                        {formatSeconds(highlight.start)}
                      </span>
                      <span>{highlight.text}</span>
                      {highlight.note && <span className="text-slate-400">（{highlight.note}）</span>}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {detail.artifacts.length > 0 && (
              <section className="mt-8">
                <h2 className="mb-2 text-lg font-bold">衍生内容（Artifacts）</h2>
                <ul className="space-y-2 text-sm">
                  {detail.artifacts.map((artifact) => (
                    <li key={artifact.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {artifact.kind} · v{artifact.version}
                      </div>
                      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                        {JSON.stringify(artifact.payload, null, 2)}
                      </pre>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {detail.transcript && (
              <section className="mt-8">
                <details>
                  <summary className="cursor-pointer text-lg font-bold">
                    转录原文（{detail.transcript.segmentCount} 段）
                  </summary>
                  <div className="mt-3 max-h-96 space-y-1 overflow-auto rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
                    {detail.transcript.segments.map((segment) => (
                      <p key={segment.idx} className="flex gap-2">
                        <span className="shrink-0 text-slate-500 dark:text-slate-400">
                          {formatSeconds(segment.start)}
                        </span>
                        <span>{segment.text}</span>
                      </p>
                    ))}
                    {detail.transcript.fullText && detail.transcript.segments.length === 0 && (
                      <p className="whitespace-pre-wrap">{detail.transcript.fullText}</p>
                    )}
                  </div>
                </details>
              </section>
            )}
          </>
        )}
      </div>
    </>
  )
}
