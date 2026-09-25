import type { NextApiRequest, NextApiResponse } from 'next'
import { buildSourceUrl, commonSubtitlesToSegments, toSummaryConfigSnapshot } from '~/lib/history/adapters'
import { persistSummarizedContent } from '~/lib/history/persist'
import { requireUserId } from '~/lib/history/server'
import { ContentRow, SummaryRow } from '~/lib/history/types'
import { buildSummarizeOpenAIPayload } from '~/lib/openai/buildSummarizeRequest'
import { fetchOpenAIResult } from '~/lib/openai/fetchOpenAIResult'
import { selectApiKeyAndActivatedLicenseKey } from '~/lib/openai/selectApiKeyAndActivatedLicenseKey'
import { VideoConfig } from '~/lib/types'

// 重新生成走完整生成链路（拉取最新字幕 → LLM → 落库），耗时较长
export const config = { maxDuration: 300 }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }

  const { id } = req.query
  if (typeof id !== 'string' || !id) {
    return res.status(400).json({ error: 'bad_request', message: 'missing id' })
  }

  try {
    const content = await auth.supabase.from('contents').select('*').eq('id', id).maybeSingle()
    if (content.error) {
      throw content.error
    }
    if (!content.data) {
      return res.status(404).json({ error: 'not_found' })
    }
    const contentRow = content.data as ContentRow

    const latestSummary = await auth.supabase
      .from('summaries')
      .select('*')
      .eq('content_id', id)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latestSummary.error) {
      throw latestSummary.error
    }
    const summaryRow = latestSummary.data as SummaryRow | null
    const storedConfig = (summaryRow?.config ?? {}) as Record<string, unknown>

    const videoConfig = {
      ...storedConfig,
      videoId: contentRow.source_ref,
      service: contentRow.service,
      pageNumber: contentRow.source_page,
    } as VideoConfig

    const { openAiPayload, title, subtitlesArray, descriptionText } = await buildSummarizeOpenAIPayload({
      videoConfig,
      userConfig: { shouldShowTimestamp: Boolean(storedConfig.showTimestamp) },
    })
    const apiKey = await selectApiKeyAndActivatedLicenseKey(undefined, contentRow.source_ref)
    const regenerated = await fetchOpenAIResult({ ...openAiPayload, stream: false }, apiKey, videoConfig)
    const summaryText = String(regenerated)

    const segments = subtitlesArray
      ? commonSubtitlesToSegments(subtitlesArray, Boolean(storedConfig.showTimestamp))
      : []
    const persisted = await persistSummarizedContent({
      supabase: auth.supabase,
      userId: auth.userId,
      media: {
        sourceUrl:
          contentRow.source_url || buildSourceUrl(contentRow.source_ref, contentRow.service, contentRow.source_page),
        service: contentRow.service,
        sourceRef: contentRow.source_ref,
        sourcePage: contentRow.source_page,
        title: title ?? contentRow.title,
        duration: contentRow.duration,
        language: contentRow.language,
      },
      segments,
      transcriptFullText: subtitlesArray ? null : descriptionText ?? null,
      config: toSummaryConfigSnapshot(videoConfig as Record<string, unknown>),
      model: openAiPayload.model,
      summaryText,
    })

    return res.status(200).json({
      ...persisted,
      summaryText,
      note: persisted.reused ? '输入与配置未变化，已复用既有版本（幂等）' : '已生成新版本',
    })
  } catch (error: any) {
    console.error('history regenerate failed:', error)
    return res.status(500).json({ error: 'internal_error', message: error?.message ?? 'Internal Server Error' })
  }
}
