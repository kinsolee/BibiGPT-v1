import { useState } from 'react'
import { BatchItemDTO } from '~/lib/batch/dto'
import { BatchStatusBadge } from './BatchStatusBadge'

interface WatchLaterPanelProps {
  items: BatchItemDTO[]
  busy: boolean
  busyItems: Set<string>
  onAdd: (url: string) => Promise<void>
  onRemove: (itemId: string) => void
}

export function WatchLaterPanel({ items, busy, busyItems, onAdd, onRemove }: WatchLaterPanelProps) {
  const [url, setUrl] = useState('')

  const submit = async () => {
    if (!url.trim() || busy) {
      return
    }
    await onAdd(url.trim())
    setUrl('')
  }

  return (
    <section className="rounded-xl border border-slate-200 p-4 shadow-sm dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">稍后再看（Watch Later）</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            供浏览器扩展 / 移动端推送视频链接，仅登记不自动总结；在下方批次列表里统一开始处理。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void submit()
              }
            }}
            placeholder="粘贴 YouTube / B 站视频链接"
            className="w-72 rounded-lg border border-slate-200 bg-transparent px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700"
          />
          <button
            type="button"
            disabled={busy || !url.trim()}
            onClick={() => void submit()}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-40 dark:bg-slate-200 dark:text-slate-900"
          >
            添加
          </button>
        </div>
      </div>

      {items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">暂无待看视频。</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <BatchStatusBadge status={item.status} />
                  {item.contentId && (
                    <a
                      href={`/user/videos/${item.contentId}`}
                      className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                    >
                      查看摘要
                    </a>
                  )}
                </div>
                <a
                  href={item.sourceUrl ?? '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-0.5 block truncate hover:underline"
                >
                  {item.title || item.sourceUrl}
                </a>
              </div>
              {item.status !== 'running' && (
                <button
                  type="button"
                  disabled={busyItems.has(item.id)}
                  onClick={() => onRemove(item.id)}
                  className="shrink-0 text-xs text-red-500 hover:underline disabled:opacity-40"
                >
                  移除
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
