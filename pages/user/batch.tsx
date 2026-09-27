import { useUser } from '@supabase/auth-helpers-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BatchCollectionCard } from '~/components/batch/BatchCollectionCard'
import { WatchLaterPanel } from '~/components/batch/WatchLaterPanel'
import { Sidebar } from '~/components/sidebar'
import {
  batchCollectionAction,
  batchItemAction,
  BatchApiError,
  BatchCollectionAction,
  BatchItemAction,
  deleteBatchCollection,
  fetchBatchCollectionDetail,
  fetchBatchCollections,
  fetchWatchLater,
  importCollectionRequest,
  addWatchLaterUrls,
  removeBatchItem,
  removeWatchLaterItem,
} from '~/hooks/useBatch'
import { useToast } from '~/hooks/use-toast'
import { BatchCollectionDTO, BatchCollectionDetailDTO, BatchItemDTO } from '~/lib/batch/dto'

const POLL_INTERVAL_MS = 4000

const ACTION_TOASTS: Partial<Record<BatchCollectionAction, string>> = {
  start: '批次已开始后台执行',
  retryFailed: '失败项已重置并开始执行',
  clearFailed: '失败项已清理',
}

export default function BatchPage() {
  const user = useUser()
  const { toast } = useToast()
  const [collections, setCollections] = useState<BatchCollectionDTO[]>([])
  const [details, setDetails] = useState<Record<string, BatchCollectionDetailDTO>>({})
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [watchLaterItems, setWatchLaterItems] = useState<BatchItemDTO[]>([])
  const [watchLaterCollectionId, setWatchLaterCollectionId] = useState<string | null>(null)
  const [importUrl, setImportUrl] = useState('')
  const [importing, setImporting] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [busyItems, setBusyItems] = useState<Set<string>>(new Set())
  const [watchLaterBusy, setWatchLaterBusy] = useState(false)
  const busyRef = useRef(false)

  const loadCollections = useCallback(async () => {
    const result = await fetchBatchCollections()
    setCollections(result.collections)
    return result.collections
  }, [])

  const loadWatchLater = useCallback(async () => {
    const result = await fetchWatchLater()
    setWatchLaterItems(result.items)
    setWatchLaterCollectionId(result.collection.id)
  }, [])

  const loadAll = useCallback(async () => {
    await Promise.all([loadCollections(), loadWatchLater()])
  }, [loadCollections, loadWatchLater])

  const refreshDetail = useCallback(async (id: string) => {
    const result = await fetchBatchCollectionDetail(id)
    setDetails((prev) => ({ ...prev, [id]: result.collection }))
    return result.collection
  }, [])

  useEffect(() => {
    if (!user) {
      return
    }
    setLoading(true)
    setError(null)
    loadAll()
      .catch((e) =>
        setError(e instanceof BatchApiError && e.status === 401 ? '请先登录后使用批量处理' : (e as Error).message),
      )
      .finally(() => setLoading(false))
  }, [user, loadAll])

  // 有批次在后台执行时轮询进度
  useEffect(() => {
    if (!user || !collections.some((collection) => collection.batchStatus === 'running')) {
      return
    }
    const timer = setInterval(() => {
      if (busyRef.current) {
        return
      }
      void loadAll().catch(() => null)
      if (expandedId) {
        void refreshDetail(expandedId).catch(() => null)
      }
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [user, collections, expandedId, loadAll, refreshDetail])

  const guard = async (fn: () => Promise<void>) => {
    busyRef.current = true
    try {
      await fn()
    } catch (e) {
      toast({ variant: 'destructive', title: '操作失败', description: (e as Error).message })
    } finally {
      busyRef.current = false
    }
  }

  const handleImport = () =>
    guard(async () => {
      if (!importUrl.trim()) {
        return
      }
      setImporting(true)
      try {
        const result = await importCollectionRequest(importUrl.trim())
        toast({
          description: `导入成功：新增 ${result.imported} 条${
            result.duplicates > 0 ? `，跳过重复/超出上限 ${result.duplicates} 条` : ''
          }（未自动总结）`,
        })
        setImportUrl('')
        await loadCollections()
        setExpandedId(result.collection.id)
        setDetails((prev) => ({ ...prev, [result.collection.id]: result.collection }))
      } finally {
        setImporting(false)
      }
    })

  const withBusy = async (id: string, fn: () => Promise<void>) => {
    setBusyId(id)
    await guard(fn)
    setBusyId(null)
  }

  const handleCollectionAction = (collectionId: string, action: BatchCollectionAction) =>
    withBusy(collectionId, async () => {
      const result = await batchCollectionAction(collectionId, action)
      const label = ACTION_TOASTS[action]
      if (label) {
        const extra =
          action === 'start' || action === 'retryFailed'
            ? `（待处理 ${result.pendingItems ?? 0} 项）`
            : action === 'clearFailed'
            ? `（移除 ${result.removed ?? 0} 项）`
            : ''
        toast({ description: `${label}${extra}` })
      }
      await Promise.all([loadCollections(), refreshDetail(collectionId).catch(() => null)])
    })

  const handleDeleteCollection = (collectionId: string) =>
    withBusy(collectionId, async () => {
      if (!window.confirm('确定删除该批次及其全部条目吗？（已生成的摘要保留在历史记录中）')) {
        return
      }
      await deleteBatchCollection(collectionId)
      toast({ description: '批次已删除' })
      if (expandedId === collectionId) {
        setExpandedId(null)
      }
      await loadAll()
    })

  const setItemBusy = (itemId: string, busy: boolean) => {
    setBusyItems((prev) => {
      const next = new Set(prev)
      if (busy) {
        next.add(itemId)
      } else {
        next.delete(itemId)
      }
      return next
    })
  }

  const handleItemAction = (itemId: string, action: BatchItemAction) =>
    guard(async () => {
      setItemBusy(itemId, true)
      try {
        await batchItemAction(itemId, action)
        toast({ description: action === 'cancel' ? '已取消该项' : '该项处理完成' })
        await loadAll()
        if (expandedId) {
          await refreshDetail(expandedId).catch(() => null)
        }
      } finally {
        setItemBusy(itemId, false)
      }
    })

  const handleItemRemove = (itemId: string) =>
    guard(async () => {
      setItemBusy(itemId, true)
      try {
        await removeBatchItem(itemId)
        toast({ description: '已移除该项' })
        await loadAll()
        if (expandedId) {
          await refreshDetail(expandedId).catch(() => null)
        }
      } finally {
        setItemBusy(itemId, false)
      }
    })

  const handleWatchLaterAdd = async (url: string) => {
    setWatchLaterBusy(true)
    await guard(async () => {
      const result = await addWatchLaterUrls([url])
      const invalidNote = result.invalidUrls.length ? `，无法识别 ${result.invalidUrls.length} 条` : ''
      toast({
        variant: result.invalidUrls.length && !result.added ? 'destructive' : 'default',
        description: `已添加 ${result.added} 条${
          result.duplicates > 0 ? `，重复 ${result.duplicates} 条` : ''
        }${invalidNote}（不会自动总结）`,
      })
      await loadWatchLater()
    })
    setWatchLaterBusy(false)
  }

  const handleWatchLaterRemove = (itemId: string) =>
    guard(async () => {
      setItemBusy(itemId, true)
      try {
        await removeWatchLaterItem(itemId)
        await loadWatchLater()
      } finally {
        setItemBusy(itemId, false)
      }
    })

  const detailFor = (collection: BatchCollectionDTO) =>
    collection.batchStatus === 'running' ? details[collection.id] ?? undefined : details[collection.id]

  return (
    <>
      <Sidebar />
      <div className="p-4 sm:ml-64">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">批量处理</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            导入 YouTube 播放列表 / B 站收藏夹（合集），单次最多 50
            条，重复链接自动去重；导入不自动总结，显式开始后才逐项处理。
          </p>
        </div>

        <div className="mb-6 flex flex-col gap-3 rounded-xl border border-slate-200 p-4 shadow-sm dark:border-slate-700">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="url"
              value={importUrl}
              onChange={(e) => setImportUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  void handleImport()
                }
              }}
              placeholder="粘贴播放列表链接，如 https://www.youtube.com/playlist?list=… 或 https://space.bilibili.com/{mid}/favlist?fid=…"
              className="min-w-72 flex-1 rounded-lg border border-slate-200 bg-transparent px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:border-slate-700"
            />
            <button
              type="button"
              disabled={importing || !importUrl.trim()}
              onClick={() => void handleImport()}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40 dark:bg-slate-200 dark:text-slate-900"
            >
              {importing ? '导入中…' : '导入'}
            </button>
          </div>
          <p className="text-xs text-slate-400">
            支持 YouTube 播放列表、B 站收藏夹（fid）与 B 站合集（sid）；混合电台列表暂不支持。
          </p>
        </div>

        <div className="mb-6">
          <WatchLaterPanel
            items={watchLaterItems}
            busy={watchLaterBusy}
            busyItems={busyItems}
            onAdd={handleWatchLaterAdd}
            onRemove={handleWatchLaterRemove}
          />
        </div>

        {!user ? (
          <p className="text-slate-500">登录后即可使用批量处理。</p>
        ) : loading ? (
          <p className="text-slate-500">加载中…</p>
        ) : error ? (
          <p className="text-red-500">{error}</p>
        ) : collections.length === 0 ? (
          <p className="text-slate-500">还没有批次，先在上方导入一个播放列表吧。</p>
        ) : (
          <ul className="space-y-3">
            {collections.map((collection) => (
              <BatchCollectionCard
                key={collection.id}
                collection={collection}
                detail={detailFor(collection)}
                expanded={expandedId === collection.id}
                busy={busyId === collection.id}
                busyItems={busyItems}
                onToggleExpand={() => {
                  const next = expandedId === collection.id ? null : collection.id
                  setExpandedId(next)
                  if (next && !details[next]) {
                    void guard(async () => {
                      await refreshDetail(next)
                    })
                  }
                }}
                onAction={(action) => handleCollectionAction(collection.id, action)}
                onDelete={() => handleDeleteCollection(collection.id)}
                onItemAction={handleItemAction}
                onItemRemove={handleItemRemove}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
