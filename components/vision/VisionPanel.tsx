import { ImageCarousel } from '~/components/vision/ImageCarousel'
import { KeyframeTimeline } from '~/components/vision/KeyframeTimeline'

/**
 * KIN-48 视觉面板：SummaryResult 下的挂载点，聚合关键帧时间轴与图文笔记轮播。
 * 未登录/无内容时各子面板自行降级，不影响既有摘要展示。
 */
export function VisionPanel({ currentVideoUrl, currentVideoId }: { currentVideoUrl: string; currentVideoId: string }) {
  return (
    <>
      <KeyframeTimeline currentVideoUrl={currentVideoUrl} currentVideoId={currentVideoId} />
      <ImageCarousel currentVideoUrl={currentVideoUrl} />
    </>
  )
}
