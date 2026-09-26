import { useUser } from '@supabase/auth-helpers-react'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Sidebar } from '~/components/sidebar'
import { fetchHistoryList, fetchHistoryStats, HistoryApiError } from '~/hooks/useHistory'
import { HistoryListItemDTO, HistoryStatsDTO } from '~/lib/history/types'

function formatDate(value: string | null) {
  if (!value) {
    return ''
  }
  return new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

export default function DashboardPage() {
  const user = useUser()
  const [items, setItems] = useState<HistoryListItemDTO[]>([])
  const [stats, setStats] = useState<HistoryStatsDTO | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) {
      return
    }
    // 统计走 /api/history/stats（全量计数），最近列表只需第一页
    Promise.all([fetchHistoryStats(), fetchHistoryList({ pageSize: 5 })])
      .then(([statsResult, listResult]) => {
        setStats(statsResult)
        setItems(listResult.items)
      })
      .catch((e) => {
        setError(e instanceof HistoryApiError && e.status === 401 ? '请先登录后查看仪表盘' : (e as Error).message)
      })
  }, [user])

  return (
    <>
      <Sidebar />
      <div className="p-4 sm:ml-64">
        <h1 className="mb-6 text-2xl font-bold">仪表盘</h1>

        {!user ? (
          <p className="text-slate-500">登录后即可查看你的总结统计。</p>
        ) : error ? (
          <p className="text-red-500">{error}</p>
        ) : (
          <>
            <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
                <div className="text-3xl font-bold">{stats?.total ?? '…'}</div>
                <div className="text-sm text-slate-500 dark:text-slate-400">已总结视频</div>
              </div>
              <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
                <div className="text-3xl font-bold">{stats?.favorites ?? '…'}</div>
                <div className="text-sm text-slate-500 dark:text-slate-400">收藏</div>
              </div>
              <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
                <div className="text-3xl font-bold">{stats?.services ?? '…'}</div>
                <div className="text-sm text-slate-500 dark:text-slate-400">内容来源数</div>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">最近总结</h2>
              <Link href="/user/videos" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
                查看全部 →
              </Link>
            </div>
            {items.length === 0 ? (
              <p className="mt-3 text-slate-500">暂无历史记录，去首页总结一个视频吧。</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {items.map((item) => (
                  <li key={item.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                    <Link
                      href={`/user/videos/${item.id}`}
                      className="block truncate font-medium hover:text-pink-600 hover:underline"
                    >
                      {item.isFavorite ? '★ ' : ''}
                      {item.title || item.sourceRef}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">{item.service}</span>
                      <span>{formatDate(item.lastSummarizedAt || item.createdAt)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </>
  )
}
