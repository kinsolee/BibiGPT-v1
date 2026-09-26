import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSourceUrl, toSummaryConfigSnapshot } from './adapters'
import { sha256Hex, stableStringify } from './hash'
import { PROMPT_VERSION } from './persist'
import { SummaryRow } from './types'

type CachedSummaryParams = {
  supabase: SupabaseClient
  userId: string
  videoConfig: {
    videoId: string
    service?: string
    pageNumber?: null | string
    [key: string]: unknown
  }
  cacheId: string
  summaryText: string
}

/**
 * Redis 缓存命中时的渐进导入：把旧缓存摘要补录进用户历史（middleware 调用，须 Edge 兼容）。
 * 与完整落库的差异：拿不到字幕/标题，故不写 transcript，content 标题为空；
 * 幂等口径为「同内容下已存在相同配置快照的摘要即跳过」，
 * input_hash 使用 cacheId 派生，保证重复命中不产生重复行。
 */
export async function persistCachedSummary(params: CachedSummaryParams): Promise<void> {
  const { supabase, userId, videoConfig, cacheId, summaryText } = params
  if (!summaryText.trim()) {
    return
  }

  const service = videoConfig.service || 'bilibili'
  const sourcePage = videoConfig.pageNumber ? String(videoConfig.pageNumber) : null
  const snapshot = toSummaryConfigSnapshot(videoConfig)
  const snapshotKey = stableStringify(snapshot)

  let contentMatch = supabase
    .from('contents')
    .select('id')
    .eq('user_id', userId)
    .eq('service', service)
    .eq('source_ref', videoConfig.videoId)
  // PostgREST 的 is 过滤仅用于 NULL；非空 source_page 必须等值匹配
  contentMatch = sourcePage === null ? contentMatch.is('source_page', null) : contentMatch.eq('source_page', sourcePage)
  const existingContent = await contentMatch.maybeSingle()
  if (existingContent.error) {
    throw existingContent.error
  }

  let contentId = existingContent.data?.id as string | undefined
  if (!contentId) {
    const inserted = await supabase
      .from('contents')
      .insert({
        user_id: userId,
        source_url: buildSourceUrl(videoConfig.videoId, service, videoConfig.pageNumber),
        service,
        source_ref: videoConfig.videoId,
        source_page: sourcePage,
        source_metadata: sourcePage ? { pageNumber: sourcePage } : {},
        last_summarized_at: new Date().toISOString(),
      })
      .select('id')
      .single()
    if (inserted.error) {
      throw inserted.error
    }
    contentId = inserted.data.id
  }

  // 唯一索引 (content_id, version) 兜底下，读-算-插的并发冲突以重读重试解决
  for (let attempt = 0; attempt < 3; attempt++) {
    const summaries = await supabase.from('summaries').select('*').eq('content_id', contentId)
    if (summaries.error) {
      throw summaries.error
    }
    const rows = (summaries.data ?? []) as SummaryRow[]
    if (rows.some((row) => stableStringify(row.config) === snapshotKey)) {
      return
    }

    const { error } = await supabase.from('summaries').insert({
      user_id: userId,
      content_id: contentId,
      transcript_id: null,
      config: snapshot,
      model: typeof videoConfig.model === 'string' ? videoConfig.model : null,
      prompt_version: PROMPT_VERSION,
      status: 'completed',
      input_hash: await sha256Hex(`cache:${cacheId}`),
      version: rows.reduce((max, row) => Math.max(max, row.version), 0) + 1,
      content_text: summaryText,
    })
    if (!error) {
      return
    }
    if (error.code !== '23505') {
      throw error
    }
    // 冲突来源二选一：配置快照已存在（循环顶部会命中返回）或 version 并发竞争——重读后重试
  }
  throw new Error('cached summary version allocation failed after retries')
}
