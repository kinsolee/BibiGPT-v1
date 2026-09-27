import { useCallback, useEffect, useState } from 'react'

import { buildSeekUrl, formatTimestamp } from '~/lib/artifacts/seekUrl'
import { analyzeFrames, fetchVisionBundle, frameImageUrl, generateKeyframes, VisionApiError } from '~/lib/vision/client'
import type { FrameAnalysisPayload, KeyframeSetPayload } from '~/lib/vision/types'
import { useToast } from '~/hooks/use-toast'

type AnalysisMap = Record<string, FrameAnalysisPayload>

/**
 * 关键帧时间轴：缩略图条 + 时间戳跳转 + 逐帧 VLM 分析（失败可重试）。
 * 首次渲染读取已落库集合（重复打开结果一致），生成/重试走独立 API。
 */
export function KeyframeTimeline({
  currentVideoUrl,
  currentVideoId,
}: {
  currentVideoUrl: string
  currentVideoId: string
}) {
  const { toast } = useToast()
  const [payload, setPayload] = useState<KeyframeSetPayload | null>(null)
  const [analyses, setAnalyses] = useState<AnalysisMap>({})
  const [loaded, setLoaded] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsAuth, setNeedsAuth] = useState(false)
  const [audioNotice, setAudioNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!currentVideoUrl) {
      return
    }
    let cancelled = false
    setLoaded(false)
    setError(null)
    setAudioNotice(null)
    fetchVisionBundle(currentVideoUrl)
      .then((response) => {
        if (cancelled) {
          return
        }
        setPayload(response.payload)
        setAnalyses(Object.fromEntries(response.analyses.map((item) => [item.frameId, item])))
        setLoaded(true)
      })
      .catch((fetchError: unknown) => {
        if (cancelled) {
          return
        }
        setLoaded(true)
        if (fetchError instanceof VisionApiError && fetchError.status === 401) {
          setNeedsAuth(true)
        } else {
          setError(fetchError instanceof Error ? fetchError.message : '读取关键帧失败')
        }
      })
    return () => {
      cancelled = true
    }
  }, [currentVideoUrl])

  const applyAnalyses = useCallback((incoming: FrameAnalysisPayload[]) => {
    setAnalyses((prev) => {
      const next = { ...prev }
      for (const item of incoming) {
        next[item.frameId] = item
      }
      return next
    })
  }, [])

  const handleGenerate = useCallback(async () => {
    if (!currentVideoUrl || generating) {
      return
    }
    setGenerating(true)
    setError(null)
    setAudioNotice(null)
    try {
      const result = await generateKeyframes(currentVideoUrl, { force: true })
      setPayload(result.payload)
      if (result.message) {
        setAudioNotice(result.message)
      }
      toast({ description: result.reused ? '输入未变化，已复用既有关键帧' : '关键帧生成完成 ✅' })
    } catch (generateError: unknown) {
      if (generateError instanceof VisionApiError && generateError.status === 401) {
        setNeedsAuth(true)
      } else {
        setError(generateError instanceof Error ? generateError.message : '生成失败，请稍后重试')
      }
    } finally {
      setGenerating(false)
    }
  }, [currentVideoUrl, generating, toast])

  const handleAnalyze = useCallback(
    async (frameId?: string, force?: boolean) => {
      if (!currentVideoUrl) {
        return
      }
      try {
        const result = await analyzeFrames(currentVideoUrl, { frameId, force })
        applyAnalyses(result.analyses)
        if (result.errorCount > 0) {
          toast({
            variant: 'destructive',
            title: `有 ${result.errorCount} 帧分析失败`,
            description: '失败帧可单独重试，其余帧结果不受影响。',
          })
        } else {
          toast({ description: result.cachedCount > 0 ? '命中缓存，未重复调用模型 ✅' : '画面分析完成 ✅' })
        }
      } catch (analyzeError: unknown) {
        if (analyzeError instanceof VisionApiError && analyzeError.status === 401) {
          setNeedsAuth(true)
          return
        }
        toast({
          variant: 'destructive',
          title: '画面分析失败',
          description: analyzeError instanceof Error ? analyzeError.message : '请稍后重试',
        })
      }
    },
    [applyAnalyses, currentVideoUrl, toast],
  )

  if (needsAuth) {
    return (
      <div className="mx-auto mt-6 max-w-3xl rounded-xl border-2 border-dashed bg-white px-4 py-3 text-sm text-slate-400 dark:bg-slate-900">
        登录后可生成并保存关键帧与画面分析。
      </div>
    )
  }

  const frames = payload?.frames ?? []
  const hasFrames = frames.length > 0
  const failedFrameIds = frames.filter((frame) => analyses[frame.id] == null).length

  return (
    <div className="mx-auto mt-6 max-w-3xl rounded-xl border-2 bg-white p-4 shadow-md transition hover:bg-gray-50 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-base font-bold text-slate-800 dark:text-slate-100">场景关键帧</h4>
        {payload && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-300">
            阈值 {payload.threshold} · {frames.length} 帧
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {hasFrames && (
            <button
              type="button"
              onClick={() => handleAnalyze(undefined, false)}
              className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              分析全部画面
            </button>
          )}
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || !loaded}
            className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900"
          >
            {generating ? '抽帧中…（约十几秒）' : hasFrames ? '重新生成' : '生成关键帧'}
          </button>
        </div>
      </div>

      {audioNotice && (
        <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
          {audioNotice}
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

      {hasFrames && payload && (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-2">
          {frames.map((frame) => {
            const seekUrl = buildSeekUrl(currentVideoUrl, currentVideoId, frame.time)
            const analysis = analyses[frame.id]
            return (
              <figure key={frame.id} className="w-40 shrink-0">
                <img
                  src={frameImageUrl(payload.setId, frame.file)}
                  alt={`关键帧 @${formatTimestamp(frame.time)}`}
                  className="h-24 w-40 rounded-md border border-slate-200 object-cover dark:border-slate-700"
                  loading="lazy"
                />
                <figcaption className="mt-1 flex items-center justify-between text-xs">
                  {seekUrl ? (
                    <a
                      href={seekUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-sky-500 hover:text-sky-700"
                      title="跳转到视频对应时间"
                    >
                      {formatTimestamp(frame.time)} ↗
                    </a>
                  ) : (
                    <span className="font-mono text-slate-500">{formatTimestamp(frame.time)}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => handleAnalyze(frame.id, analysis === undefined)}
                    className="text-slate-400 underline hover:text-slate-600 dark:hover:text-slate-200"
                  >
                    {analysis ? '重分析' : '分析'}
                  </button>
                </figcaption>
                {analysis && (
                  <div className="mt-1 rounded bg-slate-50 px-1.5 py-1 text-xs leading-5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {analysis.description}
                    {analysis.ocr && <div className="mt-0.5 text-slate-400">OCR：{analysis.ocr}</div>}
                  </div>
                )}
              </figure>
            )
          })}
        </div>
      )}

      {hasFrames && failedFrameIds > 0 && (
        <div className="mt-1 text-xs text-slate-400">
          {failedFrameIds} 帧尚无画面分析，可点击单帧「分析」或「分析全部画面」。
        </div>
      )}

      {!hasFrames && loaded && !generating && !error && (
        <div className="mt-2 text-sm text-slate-400">
          关键帧基于场景切分从本地上传视频中抽取（BIBI_VISION_SCENE_THRESHOLD 可调阈值），每帧可跳转到视频对应时间。
        </div>
      )}
    </div>
  )
}
