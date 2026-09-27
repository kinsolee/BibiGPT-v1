import { buildSeekUrl, formatTimestamp } from '~/lib/artifacts/seekUrl'
import type { ArtifactChapterItem } from '~/lib/artifacts/types'

const BAR_COLORS = [
  'bg-pink-400 hover:bg-pink-500',
  'bg-sky-400 hover:bg-sky-500',
  'bg-amber-400 hover:bg-amber-500',
  'bg-emerald-400 hover:bg-emerald-500',
  'bg-violet-400 hover:bg-violet-500',
  'bg-rose-400 hover:bg-rose-500',
  'bg-cyan-400 hover:bg-cyan-500',
  'bg-lime-400 hover:bg-lime-500',
]

function chapterEnd(chapter: ArtifactChapterItem, totalDuration: number | null): number {
  if (chapter.end !== null && chapter.end > (chapter.start ?? 0)) {
    return chapter.end
  }
  return totalDuration ?? (chapter.start ?? 0) + 60
}

/**
 * 章节时间轴：按比例分段的色条 + 章节列表，点击任一处跳转到对应时间点。
 * 跳转 URL 与 Sentence 组件共用 buildSeekUrl。
 */
export function TimelinePanel({
  chapters,
  videoUrl,
  videoId,
  duration,
}: {
  chapters: ArtifactChapterItem[]
  videoUrl: string
  videoId: string
  duration: number | null
}) {
  if (!chapters.length) {
    return null
  }
  const totalDuration = duration ?? chapterEnd(chapters[chapters.length - 1], null)

  return (
    <div className="mt-4">
      <div className="flex h-4 w-full overflow-hidden rounded-md">
        {chapters.map((chapter) => {
          const start = chapter.start ?? 0
          const width = Math.max(0, ((chapterEnd(chapter, totalDuration) - start) / Math.max(totalDuration, 1)) * 100)
          const seekUrl = buildSeekUrl(videoUrl, videoId, start)
          return (
            <a
              key={chapter.idx}
              href={seekUrl ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              title={`${formatTimestamp(chapter.start)} ${chapter.title}`}
              className={`${BAR_COLORS[chapter.idx % BAR_COLORS.length]} border-r border-white/70 transition-colors`}
              style={{ width: `${width}%` }}
            />
          )
        })}
      </div>
      <ul className="mt-3 space-y-1 text-sm">
        {chapters.map((chapter) => {
          const seekUrl = buildSeekUrl(videoUrl, videoId, chapter.start)
          return (
            <li key={chapter.idx} className="flex items-baseline gap-2">
              <a
                href={seekUrl ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 font-mono text-xs text-sky-500 hover:text-sky-700"
              >
                {formatTimestamp(chapter.start)}
              </a>
              <span className="text-slate-700 dark:text-slate-200">
                {chapter.title}
                {chapter.summary ? (
                  <span className="text-slate-400 dark:text-slate-500"> — {chapter.summary}</span>
                ) : null}
                {chapter.source === 'platform' ? (
                  <span className="ml-1 rounded bg-emerald-100 px-1 text-xs text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                    平台
                  </span>
                ) : null}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
