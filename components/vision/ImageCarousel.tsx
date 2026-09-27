import { useCallback, useEffect, useState } from 'react'

import { regenerateHistorySummary } from '~/hooks/useHistory'
import { useToast } from '~/hooks/use-toast'
import { fetchImageNoteImages, VisionApiError } from '~/lib/vision/client'

interface CarouselImage {
  url: string
  alt?: string
}

/**
 * 图文笔记 image carousel：保留来源图片顺序的原图轮播，重新打开仍可查看；
 * 「一键总结」复用既有摘要管线（history regenerate 入口，重新走完整生成链路）。
 */
export function ImageCarousel({ currentVideoUrl }: { currentVideoUrl: string }) {
  const { toast } = useToast()
  const [images, setImages] = useState<CarouselImage[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [status, setStatus] = useState<'loading' | 'ready' | 'hidden'>('loading')
  const [reason, setReason] = useState<string | null>(null)
  const [contentId, setContentId] = useState<string | null>(null)
  const [summarizing, setSummarizing] = useState(false)

  useEffect(() => {
    if (!currentVideoUrl) {
      return
    }
    let cancelled = false
    setStatus('loading')
    setReason(null)
    fetchImageNoteImages(currentVideoUrl)
      .then((response) => {
        if (cancelled) {
          return
        }
        setContentId(response.contentId)
        if (response.images.length) {
          setImages(response.images)
          setActiveIndex(0)
          setStatus('ready')
          setReason(response.status === 'cache' ? '来源实时拉取失败，展示缓存图片' : null)
        } else {
          setImages([])
          setStatus('hidden')
          setReason(response.reason ?? null)
        }
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return
        }
        if (error instanceof VisionApiError && error.status === 401) {
          setStatus('hidden')
          return
        }
        setImages([])
        setStatus('hidden')
        setReason(error instanceof Error ? error.message : '图片拉取失败')
      })
    return () => {
      cancelled = true
    }
  }, [currentVideoUrl])

  const handleSummarize = useCallback(async () => {
    if (!contentId || summarizing) {
      return
    }
    setSummarizing(true)
    try {
      const result = await regenerateHistorySummary(contentId)
      toast({ description: result.note })
    } catch (error: unknown) {
      toast({
        variant: 'destructive',
        title: '总结失败',
        description: error instanceof Error ? error.message : '请稍后重试',
      })
    } finally {
      setSummarizing(false)
    }
  }, [contentId, summarizing, toast])

  if (status === 'hidden') {
    if (reason) {
      return (
        <div className="mx-auto mt-6 max-w-3xl rounded-xl border-2 border-dashed bg-white px-4 py-3 text-sm text-slate-400 dark:bg-slate-900">
          图片笔记：{reason}
        </div>
      )
    }
    return null
  }

  const active = images[activeIndex]

  return (
    <div className="mx-auto mt-6 max-w-3xl rounded-xl border-2 bg-white p-4 shadow-md transition hover:bg-gray-50 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-base font-bold text-slate-800 dark:text-slate-100">图文笔记</h4>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-300">
          {images.length} 张原图
        </span>
        <div className="ml-auto flex items-center gap-2">
          <a
            href={active?.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            打开原图
          </a>
          <button
            type="button"
            onClick={handleSummarize}
            disabled={summarizing || !contentId}
            title={contentId ? undefined : '需先在主流程完成一次摘要入库'}
            className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {summarizing ? '总结中…' : '一键总结'}
          </button>
        </div>
      </div>

      {reason && <div className="mt-2 text-xs text-amber-600 dark:text-amber-300">{reason}</div>}

      {status === 'loading' ? (
        <div className="mt-3 text-sm text-slate-400">图片加载中…</div>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveIndex((index) => Math.max(0, index - 1))}
              disabled={activeIndex === 0}
              className="rounded-md border border-slate-200 px-2 py-1 text-sm disabled:opacity-30 dark:border-slate-700"
              aria-label="上一张"
            >
              ‹
            </button>
            {/* 原图直出（保留顺序），不用 next/image 压缩，保证重新打开看到的就是原图 */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={active?.url}
              alt={active?.alt || `第 ${activeIndex + 1} 张`}
              className="mx-auto max-h-96 rounded-lg object-contain"
            />
            <button
              type="button"
              onClick={() => setActiveIndex((index) => Math.min(images.length - 1, index + 1))}
              disabled={activeIndex >= images.length - 1}
              className="rounded-md border border-slate-200 px-2 py-1 text-sm disabled:opacity-30 dark:border-slate-700"
              aria-label="下一张"
            >
              ›
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400">
            <div className="flex flex-wrap gap-1">
              {images.map((image, index) => (
                <button
                  key={`${image.url}-${index}`}
                  type="button"
                  onClick={() => setActiveIndex(index)}
                  className={`h-1.5 w-6 rounded-full ${
                    index === activeIndex ? 'bg-pink-500' : 'bg-slate-200 dark:bg-slate-700'
                  }`}
                  aria-label={`第 ${index + 1} 张`}
                />
              ))}
            </div>
            <span>
              {activeIndex + 1} / {images.length}（顺序与来源一致）
            </span>
          </div>
        </>
      )}
    </div>
  )
}
