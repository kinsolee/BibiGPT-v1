import type { NextApiRequest, NextApiResponse } from 'next'
import { requireUserId } from '~/lib/history/server'
import { clearMessages, findConversation, listConversations, resolveContent } from '~/lib/chat/store'
import type { ChatSourceKey } from '~/lib/chat/types'

function parsePositiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseSourceKey(query: NextApiRequest['query']): ChatSourceKey | null {
  const service = typeof query.service === 'string' ? query.service : ''
  const videoId = typeof query.videoId === 'string' ? query.videoId : ''
  if (!service || !videoId) {
    return null
  }
  const pageNumber = typeof query.pageNumber === 'string' && query.pageNumber.length > 0 ? query.pageNumber : null
  return { service, videoId, pageNumber }
}

/**
 * GET /api/conversations
 *   ?service=&videoId=&pageNumber=  → 定位该视频的会话（不创建；无则 conversation: null）
 *   无参                             → 分页列出本人全部会话（含所属内容标题）
 */
async function handleGet(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  const { supabase, userId } = auth
  const source = parseSourceKey(req.query)

  if (source) {
    const content = await resolveContent(supabase, userId, source)
    if (!content) {
      return res.status(200).json({ conversation: null })
    }
    const conversation = await findConversation(supabase, userId, content.id)
    return res.status(200).json({ conversation })
  }

  const page = parsePositiveInt(req.query.page, 1)
  const pageSize = Math.min(parsePositiveInt(req.query.pageSize, 20), 100)
  const { items, hasMore } = await listConversations(supabase, userId, page, pageSize)
  return res.status(200).json({ items, page, pageSize, hasMore })
}

/** DELETE /api/conversations?service=&videoId=&pageNumber= → 清空该视频会话的消息 */
async function handleDelete(req: NextApiRequest, res: NextApiResponse) {
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  const { supabase, userId } = auth
  const source = parseSourceKey(req.query)
  if (!source) {
    return res.status(400).json({ error: 'bad_request', message: 'Missing service or videoId' })
  }
  const content = await resolveContent(supabase, userId, source)
  if (!content) {
    return res.status(404).json({ error: 'not_found', message: '该视频还没有保存过摘要' })
  }
  const conversation = await findConversation(supabase, userId, content.id)
  if (!conversation) {
    return res.status(200).json({ cleared: true })
  }
  await clearMessages(supabase, conversation.id)
  return res.status(200).json({ cleared: true })
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === 'GET') {
      return await handleGet(req, res)
    }
    if (req.method === 'DELETE') {
      return await handleDelete(req, res)
    }
    res.setHeader('Allow', 'GET, DELETE')
    return res.status(405).json({ error: 'method_not_allowed', message: 'Method Not Allowed' })
  } catch (error: any) {
    console.error('[conversations] request failed:', error?.message ?? error)
    return res.status(500).json({ error: 'internal_error', message: '会话查询失败' })
  }
}
