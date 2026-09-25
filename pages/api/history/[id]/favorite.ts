import type { NextApiRequest, NextApiResponse } from 'next'
import { requireUserId } from '~/lib/history/server'

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
    const current = await auth.supabase.from('contents').select('id, is_favorite').eq('id', id).maybeSingle()
    if (current.error) {
      throw current.error
    }
    if (!current.data) {
      return res.status(404).json({ error: 'not_found' })
    }

    const next = !current.data.is_favorite
    const updated = await auth.supabase
      .from('contents')
      .update({ is_favorite: next, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select('id, is_favorite')
      .single()
    if (updated.error) {
      throw updated.error
    }
    return res.status(200).json({ id, isFavorite: updated.data.is_favorite })
  } catch (error: any) {
    console.error('history favorite failed:', error)
    return res.status(500).json({ error: 'internal_error', message: error?.message ?? 'Internal Server Error' })
  }
}
