import { useMemo, useState } from 'react'
import { buildPlainTextTranscript, buildSrt } from '~/lib/artifacts/segments'
import { buildSeekUrl, formatTimestamp } from '~/lib/artifacts/seekUrl'
import type { ArtifactBundle } from '~/lib/artifacts/types'

function downloadTextFile(filename: string, content: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

/**
 * 完整原字幕：搜索、点击跳转、复制、导出 TXT/SRT。
 * 无字幕时展示缺失原因（服务端给出的 transcriptMissingReason）。
 */
export function TranscriptView({
  transcript,
  missingReason,
  videoUrl,
  videoId,
}: {
  transcript: ArtifactBundle['transcript']
  missingReason: string | null
  videoUrl: string
  videoId: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [keyword, setKeyword] = useState('')

  const segments = transcript?.segments ?? []
  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase()
    if (!query) {
      return segments
    }
    return segments.filter((segment) => segment.text.toLowerCase().includes(query))
  }, [keyword, segments])

  return (
    <div className="mt-5 border-t border-dashed pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="text-sm font-semibold text-slate-700 hover:text-sky-600 dark:text-slate-200"
        >
          {expanded ? '▾' : '▸'} 完整原字幕{segments.length ? `（${segments.length} 段）` : ''}
        </button>
        {expanded && segments.length > 0 && (
          <>
            <input
              type="text"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索字幕内容…"
              className="ml-auto w-44 rounded-md border border-slate-200 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-sky-400 dark:border-slate-700 dark:bg-slate-800"
            />
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(buildPlainTextTranscript(segments))}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              复制全文
            </button>
            <button
              type="button"
              onClick={() =>
                downloadTextFile(`transcript-${videoId || 'video'}.txt`, buildPlainTextTranscript(segments))
              }
              className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              导出 TXT
            </button>
            <button
              type="button"
              onClick={() => downloadTextFile(`transcript-${videoId || 'video'}.srt`, buildSrt(segments))}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              导出 SRT
            </button>
          </>
        )}
      </div>

      {expanded &&
        (segments.length ? (
          <>
            <div className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-slate-100 p-2 dark:border-slate-700">
              {filtered.map((segment) => {
                const seekUrl = buildSeekUrl(videoUrl, videoId, segment.start)
                return (
                  <div key={segment.idx} className="flex items-baseline gap-2 py-0.5 text-sm">
                    <a
                      href={seekUrl ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 font-mono text-xs text-sky-500 hover:text-sky-700"
                    >
                      {formatTimestamp(segment.start)}
                    </a>
                    <span className="text-slate-700 dark:text-slate-200">
                      {segment.speaker ? <span className="mr-1 text-slate-400">[{segment.speaker}]</span> : null}
                      {segment.text}
                    </span>
                  </div>
                )
              })}
              {!filtered.length && <div className="py-2 text-sm text-slate-400">没有匹配「{keyword}」的字幕</div>}
            </div>
            {keyword && (
              <div className="mt-1 text-xs text-slate-400">
                匹配 {filtered.length}/{segments.length} 段
              </div>
            )}
          </>
        ) : (
          <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            {missingReason ?? '暂无字幕'}
          </div>
        ))}
    </div>
  )
}
