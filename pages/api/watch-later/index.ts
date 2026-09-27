import type { NextApiRequest, NextApiResponse } from 'next'
import type { SupabaseClient } from '@supabase/supabase-js'
import { batchErrorResponse, toItemDTO, toCollectionDTO } from '~/lib/batch/dto'
import { BatchItemRow } from '~/lib/batch/types'
import { addWatchLaterItems, getOrCreateWatchLaterCollection } from '~/lib/batch/watchLater'
import { requireUserId } from '~/lib/history/server'

async function loadItems(supabase: SupabaseClient, userId: string, collectionId: string) {
  const items = await supabase
    .from('collection_items')
    .select('*')
    .eq('collection_id', collectionId)
    .eq('user_id', userId)
    .order('position', { ascending: true })
  if (items.error) {
    throw items.error
  }
  return (items.data ?? []) as BatchItemRow[]
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  try {
    const collection = await getOrCreateWatchLaterCollection(auth.supabase, auth.userId)
    const items = await loadItems(auth.supabase, auth.userId, collection.id)
    return res.status(200).json({ collection: toCollectionDTO(collection, items), items: items.map(toItemDTO) })
  } catch (error: unknown) {
    return batchErrorResponse(res, error)
  }
}

async function handleAdd(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  const body = req.body as { url?: unknown; urls?: unknown } | undefined
  const urls: string[] = []
  if (typeof body?.url === 'string' && body.url.trim()) {
    urls.push(body.url)
  }
  if (Array.isArray(body?.urls)) {
    for (const entry of body.urls) {
      if (typeof entry === 'string' && entry.trim()) {
        urls.push(entry)
      }
    }
  }
  if (!urls.length) {
    return res.status(400).json({ error: 'bad_request', message: '缺少 url 或 urls 参数' })
  }
  try {
    // 只登记不总结：Watch Later 导入默认不自动触发摘要
    const result = await addWatchLaterItems(auth.supabase, auth.userId, urls)
    return res.status(200).json({
      collection: toCollectionDTO(result.collection),
      added: result.added,
      duplicates: result.duplicates,
      invalidUrls: result.invalidUrls,
    })
  } catch (error: unknown) {
    return batchErrorResponse(res, error)
  }
}

async function handleDelete(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  const id = typeof req.query.id === 'string' ? req.query.id : ''
  if (!id) {
    return res.status(400).json({ error: 'bad_request', message: '缺少 id 参数' })
  }
  try {
    const deleted = await auth.supabase
      .from('collection_items')
      .delete()
      .eq('id', id)
      .eq('user_id', auth.userId)
      .select('id')
    if (deleted.error) {
      throw deleted.error
    }
    if (!deleted.data?.length) {
      return res.status(404).json({ error: 'not_found', message: '条目不存在' })
    }
    return res.status(200).json({ deleted: true, id })
  } catch (error: unknown) {
    return batchErrorResponse(res, error)
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return handleGet(req, res)
  }
  if (req.method === 'POST') {
    return handleAdd(req, res)
  }
  if (req.method === 'DELETE') {
    return handleDelete(req, res)
  }
  res.setHeader('Allow', 'GET, POST, DELETE')
  return res.status(405).json({ error: 'method_not_allowed' })
}
