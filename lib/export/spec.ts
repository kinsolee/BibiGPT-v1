// KIN-47 ExportSpec 构建：只读既有 summary / artifact / transcript / content 数据，
// 绝不触发生成（导出不重新生成语义）。数据缺失按降级口径置空，不伪造。
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadArtifactBundle } from '~/lib/artifacts/bundle'
import { resolveContentBySource } from '~/lib/artifacts/generate'
import { parseVideoSourceUrl } from '~/lib/sources/registry'
import type { ContentRow, SummaryRow } from '~/lib/history/types'
import type { ExportArtifactRef, ExportImage, ExportSpec } from './types'
import { ExportError } from './errors'

export type BuildSpecParams = {
  contentId?: string | null
  videoUrl?: string | null
  pageNumber?: string | null
}

export async function resolveContentRow(
  supabase: SupabaseClient,
  userId: string,
  params: BuildSpecParams,
): Promise<ContentRow | null> {
  if (params.contentId) {
    const { data, error } = await supabase
      .from('contents')
      .select('*')
      .eq('id', params.contentId)
      .eq('user_id', userId)
      .maybeSingle()
    if (error) {
      throw error
    }
    return (data as ContentRow | null) ?? null
  }
  if (params.videoUrl) {
    const parsed = parseVideoSourceUrl(params.videoUrl)
    if (parsed) {
      return resolveContentBySource(supabase, userId, parsed.adapter.id, parsed.videoId, params.pageNumber ?? null)
    }
  }
  return null
}

function coerceImages(sourceMetadata: Record<string, unknown>): ExportImage[] {
  const raw = sourceMetadata?.images
  if (!Array.isArray(raw)) {
    return []
  }
  return raw
    .map((item) => {
      const candidate = item as { url?: unknown; alt?: unknown } | null
      return typeof candidate?.url === 'string'
        ? { url: candidate.url, alt: typeof candidate.alt === 'string' ? candidate.alt : null }
        : null
    })
    .filter((image): image is ExportImage => image !== null)
}

async function loadSummaryRow(supabase: SupabaseClient, contentId: string): Promise<SummaryRow | null> {
  const { data, error } = await supabase
    .from('summaries')
    .select('*')
    .eq('content_id', contentId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw error
  }
  return (data as SummaryRow | null) ?? null
}

async function loadArtifactRefs(supabase: SupabaseClient, contentId: string): Promise<ExportArtifactRef[]> {
  const { data, error } = await supabase
    .from('artifacts')
    .select('id, kind, version, created_at')
    .eq('content_id', contentId)
    .order('version', { ascending: false })
  if (error) {
    throw error
  }
  return ((data ?? []) as Array<{ id: string; kind: string; version: number; created_at: string | null }>).map(
    (row) => ({ id: row.id, kind: row.kind, version: row.version, createdAt: row.created_at }),
  )
}

export async function buildExportSpec(
  supabase: SupabaseClient,
  userId: string,
  params: BuildSpecParams,
): Promise<ExportSpec> {
  const content = await resolveContentRow(supabase, userId, params)
  if (!content) {
    throw new ExportError('content_not_found', 404, '内容不存在或不属于当前用户')
  }

  const [summary, bundle, artifactRefs] = await Promise.all([
    loadSummaryRow(supabase, content.id),
    loadArtifactBundle({ supabase, userId, contentId: content.id }),
    loadArtifactRefs(supabase, content.id),
  ])

  const bundleFound = bundle.found ? bundle : null

  return {
    title: content.title || content.source_url,
    sourceUrl: content.source_url,
    service: content.service,
    sourceRef: content.source_ref,
    duration: content.duration,
    language: content.language,
    summary: summary?.content_text ?? null,
    summaryMeta: {
      id: summary?.id ?? null,
      model: summary?.model ?? null,
      version: summary?.version ?? null,
      createdAt: summary?.created_at ?? null,
    },
    transcript: bundleFound?.transcript
      ? {
          id: bundleFound.transcript.id,
          lang: bundleFound.transcript.lang,
          fullText: bundleFound.transcript.fullText,
          segments: bundleFound.transcript.segments.map((segment) => ({
            idx: segment.idx,
            start: segment.start,
            end: segment.end,
            text: segment.text,
            speaker: segment.speaker,
          })),
        }
      : null,
    transcriptMissingReason: bundleFound?.transcriptMissingReason ?? null,
    chapters: bundleFound?.chapters ?? [],
    highlights: bundleFound?.highlights ?? [],
    keywords: bundleFound?.keywords ?? [],
    outline: bundleFound?.outline ?? [],
    // 保留字段：系统当前无说话人/反向链接数据，恒为空数组（不得伪造）
    speakers: [],
    backlinks: [],
    images: coerceImages(content.source_metadata),
    artifacts: artifactRefs,
    generatedAt: bundleFound?.generatedAt ?? null,
    exportedAt: new Date().toISOString(),
  }
}
