import { useCallback, useEffect, useState } from 'react'
import { ArtifactsApiError, fetchArtifactBundle, generateArtifacts } from '~/lib/artifacts/client'
import { buildSeekUrl, formatTimestamp } from '~/lib/artifacts/seekUrl'
import type { ArtifactBundle } from '~/lib/artifacts/types'
import { useToast } from '~/hooks/use-toast'
import { TimelinePanel } from '~/components/TimelinePanel'
import { TranscriptView } from '~/components/TranscriptView'

function chaptersToMarkdown(bundle: ArtifactBundle, videoUrl: string, videoId: string): string {
  const sourceLabel = bundle.chapterSource === 'platform' ? '（平台原始章节）' : ''
  const lines = bundle.chapters.map((chapter) => {
    const url = buildSeekUrl(videoUrl, videoId, chapter.start)
    const title = `${formatTimestamp(chapter.start)} ${chapter.title}`
    return `- [${title}](${url ?? videoUrl})${chapter.summary ? ` — ${chapter.summary}` : ''}`
  })
  return `## 章节${sourceLabel}\n${lines.join('\n')}`
}

function highlightsToMarkdown(bundle: ArtifactBundle, videoUrl: string, videoId: string): string {
  const lines = bundle.highlights.map((highlight) => {
    const url = buildSeekUrl(videoUrl, videoId, highlight.start)
    return `- [${formatTimestamp(highlight.start)}](${url ?? videoUrl}) ${highlight.text}${
      highlight.note ? `（${highlight.note}）` : ''
    }`
  })
  return `## 重点\n${lines.join('\n')}`
}

/**
 * 摘要结果下方的「章节与重点」面板：时间轴、重点、关键词、大纲与完整字幕。
 * 首次渲染读取已落库 artifacts（刷新后结果一致），点击生成/重新生成触发独立服务端 API。
 */
export function ArtifactsPanel({
  currentVideoUrl,
  currentVideoId,
}: {
  currentVideoUrl: string
  currentVideoId: string
}) {
  const { toast } = useToast()
  const [bundle, setBundle] = useState<ArtifactBundle | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsAuth, setNeedsAuth] = useState(false)

  useEffect(() => {
    if (!currentVideoUrl) {
      return
    }
    let cancelled = false
    setLoaded(false)
    setError(null)
    fetchArtifactBundle(currentVideoUrl)
      .then((response) => {
        if (cancelled) {
          return
        }
        if (response.found) {
          setBundle(response)
        } else {
          setBundle(null)
        }
        setLoaded(true)
      })
      .catch((fetchError: unknown) => {
        if (cancelled) {
          return
        }
        setLoaded(true)
        if (fetchError instanceof ArtifactsApiError && fetchError.status === 401) {
          setNeedsAuth(true)
        } else {
          setError(fetchError instanceof Error ? fetchError.message : '读取章节失败')
        }
      })
    return () => {
      cancelled = true
    }
  }, [currentVideoUrl])

  const handleGenerate = useCallback(async () => {
    if (!currentVideoUrl || generating) {
      return
    }
    setGenerating(true)
    setError(null)
    try {
      const result = await generateArtifacts(currentVideoUrl, { force: true })
      setBundle(result)
      toast({ description: result.reused ? '输入未变化，已复用既有章节' : '章节与重点生成完成 ✅' })
    } catch (generateError: unknown) {
      if (generateError instanceof ArtifactsApiError && generateError.status === 401) {
        setNeedsAuth(true)
      } else {
        const message = generateError instanceof Error ? generateError.message : '生成失败，请稍后重试'
        setError(message)
        toast({ variant: 'destructive', title: '章节生成失败', description: '已有结果不受影响，可直接重试。' })
      }
    } finally {
      setGenerating(false)
    }
  }, [currentVideoUrl, generating, toast])

  const handleCopy = useCallback(
    (text: string, label: string) => {
      navigator.clipboard
        .writeText(text)
        .then(() => toast({ description: `${label}已复制 ✂️` }))
        .catch(() => toast({ description: '复制错误 ❌' }))
    },
    [toast],
  )

  if (needsAuth) {
    return (
      <div className="mx-auto mt-6 max-w-3xl rounded-xl border-2 border-dashed bg-white px-4 py-3 text-sm text-slate-400 dark:bg-slate-900">
        登录后可生成并保存章节、重点与完整字幕。
      </div>
    )
  }

  const hasBundle = Boolean(
    bundle && (bundle.chapters.length || bundle.highlights.length || bundle.keywords.length || bundle.outline.length),
  )

  return (
    <div className="mx-auto mt-6 max-w-3xl rounded-xl border-2 bg-white p-4 shadow-md transition hover:bg-gray-50 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-base font-bold text-slate-800 dark:text-slate-100">章节与重点</h4>
        {bundle?.chapterSource === 'platform' && (
          <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
            平台原始章节
          </span>
        )}
        {bundle?.chapterSource === 'generated' && (
          <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-700 dark:bg-sky-900 dark:text-sky-300">
            AI 生成
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {hasBundle && bundle && bundle.chapters.length > 0 && (
            <button
              type="button"
              onClick={() => handleCopy(chaptersToMarkdown(bundle, currentVideoUrl, currentVideoId), '章节 ')}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              复制章节
            </button>
          )}
          {hasBundle && bundle && bundle.highlights.length > 0 && (
            <button
              type="button"
              onClick={() => handleCopy(highlightsToMarkdown(bundle, currentVideoUrl, currentVideoId), '重点 ')}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              复制重点
            </button>
          )}
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || !loaded}
            className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {generating ? '生成中…（约十几秒）' : hasBundle ? '重新生成' : '生成章节与重点'}
          </button>
        </div>
      </div>

      {bundle?.generatedAt && (
        <div className="mt-1 text-xs text-slate-400">
          生成于 {new Date(bundle.generatedAt).toLocaleString()}
          {bundle.reused ? '（输入未变化，复用既有结果）' : ''}
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-900/30 dark:text-red-300">
          {error}
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating}
            className="ml-2 underline disabled:opacity-50"
          >
            重试
          </button>
        </div>
      )}

      {hasBundle && bundle && (
        <>
          <TimelinePanel
            chapters={bundle.chapters}
            videoUrl={currentVideoUrl}
            videoId={currentVideoId}
            duration={null}
          />

          {bundle.highlights.length > 0 && (
            <div className="mt-4 border-t border-dashed pt-4">
              <h5 className="text-sm font-semibold text-slate-700 dark:text-slate-200">重点</h5>
              <ul className="mt-2 space-y-1 text-sm">
                {bundle.highlights.map((highlight) => {
                  const seekUrl = buildSeekUrl(currentVideoUrl, currentVideoId, highlight.start)
                  return (
                    <li key={highlight.idx} className="flex items-baseline gap-2">
                      <a
                        href={seekUrl ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 font-mono text-xs text-sky-500 hover:text-sky-700"
                      >
                        {formatTimestamp(highlight.start)}
                      </a>
                      <span className="text-slate-700 dark:text-slate-200">
                        {highlight.text}
                        {highlight.note ? <span className="text-slate-400">（{highlight.note}）</span> : null}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {bundle.keywords.length > 0 && (
            <div className="mt-4 border-t border-dashed pt-4">
              <h5 className="text-sm font-semibold text-slate-700 dark:text-slate-200">关键词</h5>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {bundle.keywords.map((keyword) => (
                  <span
                    key={keyword.term}
                    className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                  >
                    {keyword.term}
                  </span>
                ))}
              </div>
            </div>
          )}

          {bundle.outline.length > 0 && (
            <div className="mt-4 border-t border-dashed pt-4">
              <h5 className="text-sm font-semibold text-slate-700 dark:text-slate-200">大纲</h5>
              <ul className="mt-2 space-y-1 text-sm">
                {bundle.outline.map((item, position) => {
                  const seekUrl = buildSeekUrl(currentVideoUrl, currentVideoId, item.start)
                  return (
                    <li
                      key={`${item.title}-${position}`}
                      className={`flex items-baseline gap-2 ${
                        item.level === 2 ? 'ml-6 text-slate-500 dark:text-slate-400' : ''
                      }`}
                    >
                      {item.start !== null && (
                        <a
                          href={seekUrl ?? undefined}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="shrink-0 font-mono text-xs text-sky-500 hover:text-sky-700"
                        >
                          {formatTimestamp(item.start)}
                        </a>
                      )}
                      <span className={item.level === 1 ? 'font-medium text-slate-700 dark:text-slate-200' : ''}>
                        {item.level === 1 ? item.title : `· ${item.title}`}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          <TranscriptView
            transcript={bundle.transcript}
            missingReason={bundle.transcriptMissingReason}
            videoUrl={currentVideoUrl}
            videoId={currentVideoId}
          />
        </>
      )}

      {!hasBundle && loaded && !generating && !error && bundle?.transcriptMissingReason && (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
          {bundle.transcriptMissingReason}
        </div>
      )}

      {!hasBundle && loaded && !generating && !error && !bundle && (
        <div className="mt-2 text-sm text-slate-400">
          基于字幕生成章节时间轴、重点、关键词与完整字幕，可点击跳转到视频对应位置。
        </div>
      )}
    </div>
  )
}
