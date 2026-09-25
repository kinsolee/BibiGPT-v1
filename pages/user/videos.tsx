import { useUser } from '@supabase/auth-helpers-react'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { Sidebar } from '~/components/sidebar'
import { useToast } from '~/hooks/use-toast'
import { deleteHistoryItem, fetchHistoryList, HistoryApiError, toggleHistoryFavorite } from '~/hooks/useHistory'
import { HistoryListItemDTO } from '~/lib/history/types'

const PAGE_SIZE = 20

function formatDate(value: string | null) {
  if (!value) {
    return ''
  }
  return new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
}

export default function VideosPage() {
  const user = useUser()
  const { toast } = useToast()
  const [items, setItems] = useState<HistoryListItemDTO[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [service, setService] = useState('')
  const [favoriteOnly, setFavoriteOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    async (targetPage: number) => {
      setLoading(true)
      setError(null)
      try {
        const result = await fetchHistoryList({
          q: search,
          service: service || undefined,
          favorite: favoriteOnly,
          page: targetPage,
          pageSize: PAGE_SIZE,
        })
        setItems(result.items)
        setTotal(result.total)
        setPage(result.page)
      } catch (e) {
        setError(e instanceof HistoryApiError && e.status === 401 ? '请先登录后查看历史记录' : (e as Error).message)
        setItems([])
        setTotal(0)
      } finally {
        setLoading(false)
      }
    },
    [search, service, favoriteOnly],
  )

  useEffect(() => {
    if (user) {
      load(1)
    }
  }, [user, service, favoriteOnly])

  const handleFavorite = async (item: HistoryListItemDTO) => {
    try {
      const result = await toggleHistoryFavorite(item.id)
      setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, isFavorite: result.isFavorite } : it)))
    } catch (e) {
      toast({ variant: 'destructive', title: '收藏失败', description: (e as Error).message })
    }
  }

  const handleDelete = async (item: HistoryListItemDTO) => {
    if (!window.confirm(`确定删除「${item.title || item.sourceRef}」的全部历史记录吗？`)) {
      return
    }
    try {
      await deleteHistoryItem(item.id)
      toast({ description: '已删除' })
      load(page)
    } catch (e) {
      toast({ variant: 'destructive', title: '删除失败', description: (e as Error).message })
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <>
      <Sidebar />
      <div className="p-4 sm:ml-64">
        <div className="mb-6 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-bold">已总结的视频（{total}）</h1>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    load(1)
                  }
                }}
                placeholder="搜索标题 / 视频ID / 摘要内容"
                className="w-64 rounded-lg border border-slate-200 bg-transparent px-3 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700"
              />
              <button
                type="button"
                onClick={() => load(1)}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700 dark:bg-slate-200 dark:text-slate-900"
              >
                搜索
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <select
              value={service}
              onChange={(e) => {
                setService(e.target.value)
              }}
              className="rounded-lg border border-slate-200 bg-transparent px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900"
            >
              <option value="">全部来源</option>
              <option value="youtube">YouTube</option>
              <option value="bilibili">哔哩哔哩</option>
            </select>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={favoriteOnly} onChange={(e) => setFavoriteOnly(e.target.checked)} />
              只看收藏
            </label>
            {(search || service || favoriteOnly) && (
              <button
                type="button"
                onClick={() => {
                  setSearch('')
                  setService('')
                  setFavoriteOnly(false)
                }}
                className="text-slate-500 underline hover:text-slate-700 dark:text-slate-400"
              >
                清除筛选
              </button>
            )}
          </div>
        </div>

        {!user ? (
          <p className="text-slate-500">登录后即可查看你的总结历史。</p>
        ) : loading ? (
          <p className="text-slate-500">加载中…</p>
        ) : error ? (
          <p className="text-red-500">{error}</p>
        ) : items.length === 0 ? (
          <p className="text-slate-500">暂无历史记录，去首页总结一个视频吧。</p>
        ) : (
          <ul className="space-y-3">
            {items.map((item) => (
              <li
                key={item.id}
                className="rounded-xl border border-slate-200 p-4 shadow-sm transition hover:shadow-md dark:border-slate-700"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/user/videos/${item.id}`}
                      className="block truncate text-lg font-medium hover:text-pink-600 hover:underline"
                    >
                      {item.title || item.sourceRef}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">{item.service}</span>
                      {item.sourcePage && <span>P{item.sourcePage}</span>}
                      {item.summary && <span>v{item.summary.version}</span>}
                      <span>{formatDate(item.lastSummarizedAt || item.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-sm">
                    <button
                      type="button"
                      onClick={() => handleFavorite(item)}
                      aria-label={item.isFavorite ? '取消收藏' : '收藏'}
                      className={item.isFavorite ? 'text-yellow-500' : 'text-slate-400 hover:text-yellow-500'}
                    >
                      {item.isFavorite ? '★' : '☆'}
                    </button>
                    <Link href={`/user/videos/${item.id}`} className="text-blue-600 hover:underline dark:text-blue-400">
                      打开
                    </Link>
                    <button
                      type="button"
                      onClick={() => handleDelete(item)}
                      className="text-red-500 hover:underline"
                      aria-label="删除"
                    >
                      删除
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {total > PAGE_SIZE && (
          <div className="mt-6 flex items-center justify-center gap-4 text-sm">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => load(page - 1)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700"
            >
              上一页
            </button>
            <span>
              {page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => load(page + 1)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 disabled:opacity-40 dark:border-slate-700"
            >
              下一页
            </button>
          </div>
        )}
      </div>
    </>
  )
}
