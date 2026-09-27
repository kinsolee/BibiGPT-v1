import type { NextApiRequest, NextApiResponse } from 'next'
import type { SupabaseClient } from '@supabase/supabase-js'
import { batchErrorResponse, toCollectionDTO, toCollectionDetailDTO } from '~/lib/batch/dto'
import { importCollectionFromUrl } from '~/lib/batch/importCollection'
import { BatchCollectionRow, BatchItemRow, BatchError } from '~/lib/batch/types'
import { requireUserId } from '~/lib/history/server'

async function loadItems(supabase: SupabaseClient, collectionId: string): Promise<BatchItemRow[]> {
  const items = await supabase
    .from('collection_items')
    .select('*')
    .eq('collection_id', collectionId)
    .order('position', { ascending: true })
  if (items.error) {
    throw items.error
  }
  return (items.data ?? []) as BatchItemRow[]
}

async function handleList(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  try {
    const collections = await auth.supabase
      .from('collections')
      .select('*')
      .eq('user_id', auth.userId)
      .order('created_at', { ascending: false })
    if (collections.error) {
      throw collections.error
    }
    const rows = (collections.data ?? []) as BatchCollectionRow[]

    const items = await auth.supabase.from('collection_items').select('*').eq('user_id', auth.userId)
    if (items.error) {
      throw items.error
    }
    const itemsByCollection = new Map<string, BatchItemRow[]>()
    for (const item of (items.data ?? []) as BatchItemRow[]) {
      const list = itemsByCollection.get(item.collection_id) ?? []
      list.push(item)
      itemsByCollection.set(item.collection_id, list)
    }

    return res.status(200).json({
      collections: rows.map((row) =>
        toCollectionDTO(
          row,
          (itemsByCollection.get(row.id) ?? []).sort((a, b) => a.position - b.position),
        ),
      ),
    })
  } catch (error: unknown) {
    return batchErrorResponse(res, error)
  }
}

async function handleImport(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  const body = req.body as { url?: unknown } | undefined
  const url = typeof body?.url === 'string' ? body.url.trim() : ''
  if (!url) {
    return res.status(400).json({ error: 'bad_request', message: '缺少 url 参数' })
  }
  try {
    const result = await importCollectionFromUrl(auth.supabase, auth.userId, url)
    const items = await loadItems(auth.supabase, result.collection.id)
    return res.status(200).json({
      collection: toCollectionDetailDTO(result.collection, items),
      imported: result.imported,
      duplicates: result.duplicates,
    })
  } catch (error: unknown) {
    return batchErrorResponse(res, error)
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return handleList(req, res)
  }
  if (req.method === 'POST') {
    return handleImport(req, res)
  }
  res.setHeader('Allow', 'GET, POST')
  return res.status(405).json({ error: 'method_not_allowed' })
}
