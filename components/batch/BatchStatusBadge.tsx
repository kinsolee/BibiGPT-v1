import { BatchStatusCounts } from '~/lib/batch/dto'

export const BATCH_STATUS_LABELS: Record<string, string> = {
  pending: '待处理',
  queued: '排队中',
  running: '处理中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const BATCH_STATUS_STYLES: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  queued: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  succeeded: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  canceled: 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
}

export function BatchStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${
        BATCH_STATUS_STYLES[status] ?? BATCH_STATUS_STYLES.pending
      }`}
    >
      {BATCH_STATUS_LABELS[status] ?? status}
    </span>
  )
}

const BAR_SEGMENTS: Array<{ key: keyof BatchStatusCounts; className: string }> = [
  { key: 'succeeded', className: 'bg-green-500' },
  { key: 'running', className: 'bg-blue-500' },
  { key: 'queued', className: 'bg-amber-400' },
  { key: 'failed', className: 'bg-red-500' },
  { key: 'canceled', className: 'bg-slate-300' },
  { key: 'pending', className: 'bg-slate-200 dark:bg-slate-600' },
]

export function BatchCountsBar({ counts }: { counts: BatchStatusCounts }) {
  if (!counts.total) {
    return null
  }
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
      {BAR_SEGMENTS.map(({ key, className }) => {
        const value = counts[key]
        if (!value) {
          return null
        }
        return <div key={key} className={className} style={{ width: `${(value / counts.total) * 100}%` }} />
      })}
    </div>
  )
}
