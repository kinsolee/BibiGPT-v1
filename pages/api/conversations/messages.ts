import type { NextApiRequest, NextApiResponse } from 'next'
import { requireUserId } from '~/lib/history/server'
import { findConversation, listMessages, resolveContent } from '~/lib/chat/store'

function parsePositiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * GET /api/conversations/messages?service=&videoId=&pageNumber=&page=&pageSize=
 * 返回该视频会话的消息（按时间升序），刷新后由此恢复上下文。
 * 重试不在此实现：失败的流从不落库，客户端直接原样重发 POST /api/chat 即可。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'method_not_allowed', message: 'Method Not Allowed' })
  }

  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  const { supabase, userId } = auth

  try {
    const service = typeof req.query.service === 'string' ? req.query.service : ''
    const videoId = typeof req.query.videoId === 'string' ? req.query.videoId : ''
    const page = parsePositiveInt(req.query.page, 1)
    const pageSize = Math.min(parsePositiveInt(req.query.pageSize, 50), 100)

    const empty = { items: [], page, pageSize, hasMore: false }
    if (!service || !videoId) {
      return res.status(400).json({ error: 'bad_request', message: 'Missing service or videoId' })
    }

    const pageNumber =
      typeof req.query.pageNumber === 'string' && req.query.pageNumber.length > 0 ? req.query.pageNumber : null
    const content = await resolveContent(supabase, userId, { service, videoId, pageNumber })
    if (!content) {
      return res.status(200).json(empty)
    }
    const conversation = await findConversation(supabase, userId, content.id)
    if (!conversation) {
      return res.status(200).json(empty)
    }

    const { items, hasMore } = await listMessages(supabase, conversation.id, page, pageSize)
    return res.status(200).json({ items, page, pageSize, hasMore })
  } catch (error: any) {
    console.error('[conversations/messages] request failed:', error?.message ?? error)
    return res.status(500).json({ error: 'internal_error', message: '消息查询失败' })
  }
}
