import type { NextApiRequest, NextApiResponse } from 'next'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSourceUrl, commonSubtitlesToSegments, toSummaryConfigSnapshot } from '~/lib/history/adapters'
import { persistSummarizedContent } from '~/lib/history/persist'
import { getHistorySupabase } from '~/lib/history/server'
import { CommonSubtitleItem } from '~/lib/types'

export type HistoryUserContext = { supabase: SupabaseClient; userId: string }

/**
 * 在响应开始输出之前解析登录用户（供持久化使用）。
 * 必须在 res.write/res.end 之前调用：auth-helpers 可能需要在 res 上写会话 cookie。
 * getSession 本地校验 JWT，通常无网络请求。
 */
export async function resolveHistoryUser(
  req: NextApiRequest,
  res: NextApiResponse,
): Promise<HistoryUserContext | null> {
  try {
    const supabase = getHistorySupabase(req, res)
    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session?.user) {
      return null
    }
    return { supabase, userId: session.user.id }
  } catch (error) {
    console.error('resolve history user failed:', error)
    return null
  }
}

type PersistChatHistoryParams = {
  historyUser: HistoryUserContext | null
  videoConfig: {
    service?: string
    pageNumber?: null | string
    showTimestamp?: boolean
    [key: string]: unknown
  }
  videoId: string
  title: string | null
  subtitlesArray: Array<CommonSubtitleItem> | null
  descriptionText: string | undefined
  model: string | undefined
  summaryText: string
}

/**
 * 登录用户的摘要落库（幂等：同一输入+配置复用既有 version）。
 * 未登录：不落库，维持 Redis 临时缓存路径。
 * 落库失败只记日志，绝不影响摘要响应。
 */
export async function persistChatHistory(params: PersistChatHistoryParams) {
  const { historyUser, videoConfig, videoId, title, subtitlesArray, descriptionText, model, summaryText } = params
  if (!historyUser) {
    return
  }
  if (!summaryText.trim()) {
    return
  }
  try {
    const segments = subtitlesArray ? commonSubtitlesToSegments(subtitlesArray, videoConfig.showTimestamp) : []
    const result = await persistSummarizedContent({
      supabase: historyUser.supabase,
      userId: historyUser.userId,
      media: {
        sourceUrl: buildSourceUrl(videoId, videoConfig.service, videoConfig.pageNumber),
        service: videoConfig.service || 'bilibili',
        sourceRef: videoId,
        sourcePage: videoConfig.pageNumber ? String(videoConfig.pageNumber) : null,
        title,
        duration: null,
        language: null,
      },
      segments,
      transcriptFullText: subtitlesArray ? null : descriptionText ?? null,
      config: toSummaryConfigSnapshot(videoConfig),
      model: model ?? null,
      summaryText,
    })
    console.info(
      `history persisted: content=${result.contentId} summary=${result.summaryId} v${result.version} reused=${result.reused}`,
    )
  } catch (error) {
    console.error('persist chat history failed:', error)
  }
}
