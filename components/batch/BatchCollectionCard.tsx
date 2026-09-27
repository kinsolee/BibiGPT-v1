import { BatchCollectionDTO, BatchCollectionDetailDTO, BatchItemDTO } from '~/lib/batch/dto'
import { BatchCollectionAction, BatchItemAction } from '~/hooks/useBatch'
import { BatchCountsBar, BatchStatusBadge } from './BatchStatusBadge'

const KIND_LABELS: Record<string, string> = {
  youtube_playlist: 'YouTube 播放列表',
  bilibili_collection: 'B 站收藏夹/合集',
  watch_later: '稍后再看',
  manual: '手动',
}

const BATCH_ACTION_LABELS: Record<BatchCollectionAction, string> = {
  start: '开始',
  pause: '暂停',
  cancel: '取消批次',
  retryFailed: '重试失败',
  clearFailed: '清理失败',
}

function itemActions(item: BatchItemDTO): Array<{ action: BatchItemAction; label: string }> {
  const actions: Array<{ action: BatchItemAction; label: string }> = []
  if (item.status === 'pending' || item.status === 'queued') {
    actions.push({ action: 'start', label: '开始' })
    actions.push({ action: 'cancel', label: '取消' })
  } else if (item.status === 'failed' || item.status === 'canceled') {
    actions.push({ action: 'retry', label: '重试' })
  }
  return actions
}

interface BatchCollectionCardProps {
  collection: BatchCollectionDTO
  detail?: BatchCollectionDetailDTO
  expanded: boolean
  busy: boolean
  busyItems: Set<string>
  onToggleExpand: () => void
  onAction: (action: BatchCollectionAction) => void
  onDelete: () => void
  onItemAction: (itemId: string, action: BatchItemAction) => void
  onItemRemove: (itemId: string) => void
}

export function BatchCollectionCard({
  collection,
  detail,
  expanded,
  busy,
  busyItems,
  onToggleExpand,
  onAction,
  onDelete,
  onItemAction,
  onItemRemove,
}: BatchCollectionCardProps) {
  const { counts } = collection
  const done = counts.succeeded + counts.canceled
  const running = collection.batchStatus === 'running'

  const visibleActions: BatchCollectionAction[] = []
  if (counts.pending + counts.queued + counts.running > 0 || running) {
    if (running) {
      visibleActions.push('pause', 'cancel')
    } else {
      visibleActions.push('start')
    }
  }
  if (counts.failed > 0) {
    visibleActions.push('retryFailed', 'clearFailed')
  }

  return (
    <li className="rounded-xl border border-slate-200 p-4 shadow-sm dark:border-slate-700">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <button type="button" onClick={onToggleExpand} className="block max-w-full truncate text-left">
            <span className="text-lg font-medium hover:text-pink-600 hover:underline">
              {collection.title || collection.id}
            </span>
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">
              {KIND_LABELS[collection.kind] ?? collection.kind}
            </span>
            <span>
              共 {counts.total} 项 · 完成 {counts.succeeded} · 失败 {counts.failed}
              {counts.canceled > 0 ? ` · 已取消 ${counts.canceled}` : ''}
            </span>
            <span>{running ? '批量执行中' : collection.batchStatus === 'paused' ? '已暂停' : '空闲'}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-sm">
          {visibleActions.map((action) => (
            <button
              key={action}
              type="button"
              disabled={busy}
              onClick={() => onAction(action)}
              className={
                action === 'pause' || action === 'cancel' || action === 'clearFailed'
                  ? 'rounded-lg border border-slate-200 px-2 py-1 text-xs disabled:opacity-40 dark:border-slate-700'
                  : 'rounded-lg bg-slate-900 px-2 py-1 text-xs text-white disabled:opacity-40 dark:bg-slate-200 dark:text-slate-900'
              }
            >
              {BATCH_ACTION_LABELS[action]}
            </button>
          ))}
          <button type="button" onClick={onToggleExpand} className="text-slate-500 hover:underline dark:text-slate-400">
            {expanded ? '收起' : '明细'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onDelete}
            className="text-red-500 hover:underline disabled:opacity-40"
          >
            删除
          </button>
        </div>
      </div>

      <div className="mt-3">
        <BatchCountsBar counts={counts} />
        <p className="mt-1 text-xs text-slate-400">
          {done}/{counts.total} 已终态
        </p>
      </div>

      {expanded && (
        <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          {!detail ? (
            <p className="text-sm text-slate-500">加载明细中…</p>
          ) : detail.items.length === 0 ? (
            <p className="text-sm text-slate-500">该批次没有条目。</p>
          ) : (
            <ul className="space-y-2">
              {detail.items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400">#{item.position + 1}</span>
                      <BatchStatusBadge status={item.status} />
                      {item.attempts > 1 && <span className="text-xs text-slate-400">尝试 {item.attempts} 次</span>}
                    </div>
                    <a
                      href={item.sourceUrl ?? '#'}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-0.5 block truncate hover:underline"
                    >
                      {item.title || item.sourceUrl || item.dedupeKey}
                    </a>
                    {item.status === 'failed' && item.errorMessage && (
                      <p
                        className="mt-0.5 truncate text-xs text-red-500"
                        title={`${item.errorCode}: ${item.errorMessage}`}
                      >
                        {item.errorCode}: {item.errorMessage}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs">
                    {item.contentId && (
                      <a
                        href={`/user/videos/${item.contentId}`}
                        className="text-blue-600 hover:underline dark:text-blue-400"
                      >
                        查看摘要
                      </a>
                    )}
                    {itemActions(item).map(({ action, label }) => (
                      <button
                        key={action}
                        type="button"
                        disabled={busyItems.has(item.id)}
                        onClick={() => onItemAction(item.id, action)}
                        className="rounded border border-slate-200 px-1.5 py-0.5 disabled:opacity-40 dark:border-slate-700"
                      >
                        {label}
                      </button>
                    ))}
                    {item.status !== 'running' && (
                      <button
                        type="button"
                        disabled={busyItems.has(item.id)}
                        onClick={() => onItemRemove(item.id)}
                        className="text-red-500 hover:underline disabled:opacity-40"
                      >
                        移除
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}
