import type { NextApiRequest, NextApiResponse } from 'next'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireUserId } from '~/lib/history/server'
import { HistoryStatsDTO } from '~/lib/history/types'

/** dashboard 统计必须基于全量历史而非分页结果；服务端分页拉取 service 列表做去重计数 */
async function countDistinctServices(supabase: SupabaseClient) {
  const services = new Set<string>()
  const PAGE_SIZE = 1000
  const MAX_ROWS = 100000
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const page = await supabase
      .from('contents')
      .select('service')
      .range(from, from + PAGE_SIZE - 1)
    if (page.error) {
      throw page.error
    }
    for (const row of (page.data ?? []) as Array<{ service: string }>) {
      services.add(row.service)
    }
    if ((page.data ?? []).length < PAGE_SIZE) {
      break
    }
  }
  return services.size
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
    const total = await auth.supabase.from('contents').select('id', { count: 'exact', head: true })
    if (total.error) {
      throw total.error
    }
    const favorites = await auth.supabase
      .from('contents')
      .select('id', { count: 'exact', head: true })
      .eq('is_favorite', true)
    if (favorites.error) {
      throw favorites.error
    }

    const stats: HistoryStatsDTO = {
      total: total.count ?? 0,
      favorites: favorites.count ?? 0,
      services: await countDistinctServices(auth.supabase),
    }
    return res.status(200).json(stats)
  } catch (error: any) {
    console.error('history stats failed:', error)
    return res.status(500).json({ error: 'internal_error', message: error?.message ?? 'Internal Server Error' })
  }
}
