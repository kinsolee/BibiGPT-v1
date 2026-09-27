import type { NextApiRequest, NextApiResponse } from 'next'
import { batchErrorResponse, toCollectionDetailDTO } from '~/lib/batch/dto'
import { BatchCollectionRow, BatchItemRow } from '~/lib/batch/types'
import { requireUserId } from '~/lib/history/server'

async function loadOwnedCollection(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireUserId(req, res)
  if (!auth) {
    return null
  }
  const { id } = req.query
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: 'bad_request', message: 'missing id' })
    return null
  }
  const found = await auth.supabase
    .from('collections')
    .select('*')
    .eq('id', id)
    .eq('user_id', auth.userId)
    .maybeSingle()
  if (found.error) {
    throw found.error
  }
  if (!found.data) {
    res.status(404).json({ error: 'not_found', message: '批次不存在' })
    return null
  }
  return { auth, collection: found.data as BatchCollectionRow }
}

async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  try {
    const loaded = await loadOwnedCollection(req, res)
    if (!loaded) {
      return
    }
    const items = await loaded.auth.supabase
      .from('collection_items')
      .select('*')
      .eq('collection_id', loaded.collection.id)
      .order('position', { ascending: true })
    if (items.error) {
      throw items.error
    }
    return res.status(200).json({
      collection: toCollectionDetailDTO(loaded.collection, (items.data ?? []) as BatchItemRow[]),
    })
  } catch (error: unknown) {
    return batchErrorResponse(res, error)
  }
}

async function handleDelete(req: NextApiRequest, res: NextApiResponse) {
  try {
    const loaded = await loadOwnedCollection(req, res)
    if (!loaded) {
      return
    }
    const deleted = await loaded.auth.supabase.from('collections').delete().eq('id', loaded.collection.id).select('id')
    if (deleted.error) {
      throw deleted.error
    }
    return res.status(200).json({ deleted: true, id: loaded.collection.id })
  } catch (error: unknown) {
    return batchErrorResponse(res, error)
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return handleGet(req, res)
  }
  if (req.method === 'DELETE') {
    return handleDelete(req, res)
  }
  res.setHeader('Allow', 'GET, DELETE')
  return res.status(405).json({ error: 'method_not_allowed' })
}
