import type { SupabaseClient } from '@supabase/supabase-js'
import { sha256Hex, stableStringify } from '~/lib/history/hash'
import type {
  ArtifactChapterItem,
  ArtifactChapterSource,
  ArtifactHighlightItem,
  ArtifactKeywordItem,
  ArtifactOutlineItem,
} from './types'
import { ARTIFACTS_PROMPT_VERSION } from './model'

export type PersistArtifactsParams = {
  supabase: SupabaseClient
  userId: string
  contentId: string
  summaryId: string | null
  transcriptId: string | null
  chapterSource: ArtifactChapterSource
  chapters: ArtifactChapterItem[]
  highlights: ArtifactHighlightItem[]
  keywords: ArtifactKeywordItem[]
  outline: ArtifactOutlineItem[]
  model: string | null
  segmentCount: number
  /** true 时跳过幂等检查，强制追加新版本（用户显式重新生成） */
  force?: boolean
}

export type PersistArtifactsResult = {
  reused: boolean
  versions: Record<string, number>
}

export async function computeArtifactsInputHash(params: {
  transcriptId: string | null
  segmentCount: number
  model: string | null
  chapterSource: ArtifactChapterSource
}) {
  return sha256Hex(
    stableStringify({
      promptVersion: ARTIFACTS_PROMPT_VERSION,
      transcriptId: params.transcriptId,
      segmentCount: params.segmentCount,
      model: params.model,
      chapterSource: params.chapterSource,
    }),
  )
}

async function nextArtifactVersion(supabase: SupabaseClient, contentId: string, kind: string): Promise<number> {
  const latest = await supabase
    .from('artifacts')
    .select('version')
    .eq('content_id', contentId)
    .eq('kind', kind)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latest.error) {
    throw latest.error
  }
  return (latest.data?.version ?? 0) + 1
}

export async function persistArtifacts(params: PersistArtifactsParams): Promise<PersistArtifactsResult> {
  const { supabase, userId, contentId, summaryId, transcriptId, chapterSource } = params
  const inputHash = await computeArtifactsInputHash({
    transcriptId,
    segmentCount: params.segmentCount,
    model: params.model,
    chapterSource,
  })

  // 幂等：同一输入（转录 + 模型 + 章节来源）已生成过则直接复用，不追加版本。
  // 只有显式 force（重新生成按钮）才追加新版本；生成失败发生在写入之前，旧版本不受影响。
  if (!params.force) {
    const existing = await supabase
      .from('artifacts')
      .select('id')
      .eq('content_id', contentId)
      .eq('kind', 'chapters')
      .contains('refs', { inputHash })
      .maybeSingle()
    if (existing.error) {
      throw existing.error
    }
    if (existing.data) {
      return { reused: true, versions: {} }
    }
  }

  const refs = { transcriptId, inputHash, segmentCount: params.segmentCount }
  const kinds: Array<{ kind: string; payload: Record<string, unknown> }> = [
    { kind: 'chapters', payload: { source: chapterSource, items: params.chapters } },
    { kind: 'highlights', payload: { items: params.highlights } },
    { kind: 'keywords', payload: { items: params.keywords } },
    { kind: 'outline', payload: { items: params.outline } },
  ]

  const versions: Record<string, number> = {}
  for (const { kind, payload } of kinds) {
    const version = await nextArtifactVersion(supabase, contentId, kind)
    const inserted = await supabase
      .from('artifacts')
      .insert({ user_id: userId, content_id: contentId, summary_id: summaryId, kind, version, payload, refs })
      .select('version')
      .single()
    if (inserted.error) {
      throw inserted.error
    }
    versions[kind] = inserted.data.version
  }

  // chapters/highlights 关系表镜像：供 history 详情等关系查询使用。
  // 表无 version 列，成功生成后整组替换；替换失败时 artifacts payload 仍是 canonical 数据。
  await supabase.from('chapters').delete().eq('content_id', contentId)
  if (params.chapters.length) {
    const inserted = await supabase.from('chapters').insert(
      params.chapters.map((chapter) => ({
        user_id: userId,
        content_id: contentId,
        summary_id: summaryId,
        idx: chapter.idx,
        start: chapter.start,
        end: chapter.end,
        title: chapter.title,
        summary: chapter.summary,
      })),
    )
    if (inserted.error) {
      console.error('[artifacts] chapters mirror failed:', inserted.error)
    }
  }

  await supabase.from('highlights').delete().eq('content_id', contentId)
  if (params.highlights.length) {
    const inserted = await supabase.from('highlights').insert(
      params.highlights.map((highlight) => ({
        user_id: userId,
        content_id: contentId,
        summary_id: summaryId,
        idx: highlight.idx,
        start: highlight.start,
        end: highlight.end,
        text: highlight.text,
        note: highlight.note,
      })),
    )
    if (inserted.error) {
      console.error('[artifacts] highlights mirror failed:', inserted.error)
    }
  }

  return { reused: false, versions }
}
