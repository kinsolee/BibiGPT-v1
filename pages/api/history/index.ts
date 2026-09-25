import type { NextApiRequest, NextApiResponse } from 'next'
import type { SupabaseClient } from '@supabase/supabase-js'
import { toListItem } from '~/lib/history/dto'
import { requireUserId } from '~/lib/history/server'
import { ContentRow, HistoryListResponse, SummaryRow } from '~/lib/history/types'

/** or(...) 过滤表达式里不允许的字符 */
function sanitizeSearchTerm(term: string) {
  return term.replace(/[,()*\\]/g, ' ').trim()
}

function parsePositiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

async function pickLatestSummaries(supabase: SupabaseClient, contentIds: string[]) {
  if (!contentIds.length) {
    return new Map<string, SummaryRow>()
  }
  const { data, error } = await supabase
    .from('summaries')
    .select('*')
    .in('content_id', contentIds)
    .order('version', { ascending: false })
  if (error) {
    throw error
  }
  const latest = new Map<string, SummaryRow>()
  for (const row of (data ?? []) as SummaryRow[]) {
    if (!latest.has(row.content_id)) {
      latest.set(row.content_id, row)
    }
  }
  return latest
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }

  try {
    const page = parsePositiveInt(req.query.page, 1)
    const pageSize = Math.min(parsePositiveInt(req.query.pageSize, 20), 100)
    const service = typeof req.query.service === 'string' && req.query.service ? req.query.service : null
    const favoriteOnly = req.query.favorite === '1' || req.query.favorite === 'true'
    const search = sanitizeSearchTerm(String(req.query.q ?? ''))

    let query = auth.supabase.from('contents').select('*', { count: 'exact' })

    if (service) {
      query = query.eq('service', service)
    }
    if (favoriteOnly) {
      query = query.eq('is_favorite', true)
    }
    if (search) {
      // 搜索命中：标题 / source_ref / source_url / 任意版本的摘要正文
      const summaryHits = await auth.supabase
        .from('summaries')
        .select('content_id')
        .ilike('content_text', `%${search}%`)
        .limit(500)
      if (summaryHits.error) {
        throw summaryHits.error
      }
      const hitIds = Array.from(
        new Set(((summaryHits.data ?? []) as Array<{ content_id: string }>).map((r) => r.content_id)),
      )
      const escaped = search.replace(/,/g, '')
      const orParts = [
        `title.ilike.%${escaped}%`,
        `source_ref.ilike.%${escaped}%`,
        `source_url.ilike.%${escaped}%`,
        ...(hitIds.length ? [`id.in.(${hitIds.join(',')})`] : []),
      ]
      query = query.or(orParts.join(','))
    }

    const contents = await query
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1)
    if (contents.error) {
      throw contents.error
    }
    const rows = (contents.data ?? []) as ContentRow[]
    const latestSummaries = await pickLatestSummaries(
      auth.supabase,
      rows.map((row) => row.id),
    )

    const response: HistoryListResponse = {
      items: rows.map((row) => toListItem(row, latestSummaries.get(row.id) ?? null)),
      total: contents.count ?? rows.length,
      page,
      pageSize,
    }
    return res.status(200).json(response)
  } catch (error: any) {
    console.error('history list failed:', error)
    return res.status(500).json({ error: 'internal_error', message: error?.message ?? 'Internal Server Error' })
  }
}
