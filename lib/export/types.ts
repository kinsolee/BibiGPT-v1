// KIN-47 统一导出规格（ExportSpec）与集成管线的前后端共享契约。
// 字段与 KIN-42 lib/artifacts/types.ts 的 ArtifactBundle、KIN-41 lib/history/types.ts 的表行对齐。
// 降级口径：speakers/backlinks 为保留字段（当前系统无此数据，构建时恒为空数组，不得伪造）。

import type {
  ArtifactChapterItem,
  ArtifactHighlightItem,
  ArtifactKeywordItem,
  ArtifactOutlineItem,
} from '~/lib/artifacts/types'

export const EXPORT_FORMATS = ['markdown', 'json', 'pdf', 'docx'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export function isExportFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && (EXPORT_FORMATS as readonly string[]).includes(value)
}

export type ExportImage = { url: string; alt: string | null }

export type ExportArtifactRef = { id: string; kind: string; version: number; createdAt: string | null }

export type ExportSpeakerRef = { name: string; segmentIds: number[] }

export type ExportBacklinkRef = { contentId: string; title: string | null }

export type ExportSpec = {
  title: string
  sourceUrl: string | null
  service: string | null
  sourceRef: string | null
  duration: number | null
  language: string | null
  /** polished article（摘要正文），不含任何注入的 timestamp */
  summary: string | null
  summaryMeta: { id: string | null; model: string | null; version: number | null; createdAt: string | null }
  transcript: {
    id: string | null
    lang: string | null
    fullText: string | null
    segments: Array<{ idx: number; start: number | null; end: number | null; text: string; speaker: string | null }>
  } | null
  /** 有内容但拿不到字幕时的缺失原因（与 ArtifactBundle 同口径） */
  transcriptMissingReason: string | null
  chapters: ArtifactChapterItem[]
  highlights: ArtifactHighlightItem[]
  keywords: ArtifactKeywordItem[]
  outline: ArtifactOutlineItem[]
  /** 保留字段：当前恒为 [] */
  speakers: ExportSpeakerRef[]
  /** 保留字段：当前恒为 [] */
  backlinks: ExportBacklinkRef[]
  images: ExportImage[]
  artifacts: ExportArtifactRef[]
  generatedAt: string | null
  exportedAt: string
}

export type ExportIntegrationStatus = 'active' | 'disabled'

/** GET /api/export/integrations 返回的 provider 元信息 */
export type ExportProviderMeta = {
  id: string
  displayName: string
  kind: 'webhook' | 'app' | 'unimplemented'
  secretLabel: string | null
  configFields: Array<{ key: string; label: string; required?: boolean; placeholder?: string }>
  envConfigured: boolean
}

/** export_integrations 行（脱敏视图：secret 永不出服务端） */
export type ExportIntegrationDTO = {
  provider: string
  displayName: string | null
  status: ExportIntegrationStatus
  hasSecret: boolean
  createdAt: string | null
  updatedAt: string | null
}

export type ExportDeliveryDTO = {
  id: string
  provider: string
  contentId: string
  status: 'succeeded' | 'failed'
  attempts: number
  lastErrorCode: string | null
  lastErrorMessage: string | null
  externalUrl: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** 渲染接口返回的签名下载信息 */
export type ExportRenderResponse = {
  downloadUrl: string
  expiresAt: string
  format: ExportFormat
  filename: string
}
