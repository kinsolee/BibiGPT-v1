import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessageDTO, ChatRole, Citation, ConversationDTO } from '~/lib/chat/types'
import type { ChatSourceKey } from '~/lib/chat/types'
import type { ContentRow } from '~/lib/history/types'

type DbMessage = {
  id: string
  role: string
  content: string
  citations: Citation[] | null
  created_at: string
}

/**
 * 按 (user_id, service, source_ref, source_page) 定位已保存视频，
 * 匹配语义与 lib/history/persist.ts 的 findContentId 一致。
 */
export async function resolveContent(
  supabase: SupabaseClient,
  userId: string,
  source: ChatSourceKey,
): Promise<ContentRow | null> {
  let match = supabase
    .from('contents')
    .select('*')
    .eq('user_id', userId)
    .eq('service', source.service)
    .eq('source_ref', source.videoId)
  match = source.pageNumber === null ? match.is('source_page', null) : match.eq('source_page', source.pageNumber)
  const { data, error } = await match.maybeSingle()
  if (error) {
    throw error
  }
  return (data as ContentRow | null) ?? null
}

export async function findConversation(
  supabase: SupabaseClient,
  userId: string,
  contentId: string,
): Promise<ConversationDTO | null> {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, content_id, title, created_at, updated_at')
    .eq('user_id', userId)
    .eq('content_id', contentId)
    .maybeSingle()
  if (error) {
    throw error
  }
  return data ? toConversationDTO(data) : null
}

/** 会话不存在则创建（唯一约束兜底并发，冲突后回读） */
export async function ensureConversation(
  supabase: SupabaseClient,
  userId: string,
  contentId: string,
): Promise<ConversationDTO> {
  const existing = await findConversation(supabase, userId, contentId)
  if (existing) {
    return existing
  }
  const inserted = await supabase
    .from('conversations')
    .insert({ user_id: userId, content_id: contentId })
    .select('id, content_id, title, created_at, updated_at')
    .single()
  if (!inserted.error) {
    return toConversationDTO(inserted.data)
  }
  if (inserted.error.code === '23505') {
    const again = await findConversation(supabase, userId, contentId)
    if (again) {
      return again
    }
  }
  throw inserted.error
}

export async function listConversations(
  supabase: SupabaseClient,
  userId: string,
  page: number,
  pageSize: number,
): Promise<{
  items: Array<ConversationDTO & { contentTitle: string | null; service: string; sourceRef: string }>
  hasMore: boolean
}> {
  const { data, error } = await supabase
    .from('conversations')
    .select('id, content_id, title, created_at, updated_at, content:contents(title, service, source_ref)')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize)
  if (error) {
    throw error
  }
  const rows = (data ?? []) as unknown as Array<{
    id: string
    content_id: string
    title: string | null
    created_at: string
    updated_at: string
    content: { title: string | null; service: string; source_ref: string } | null
  }>
  const items = rows.map((row) => ({
    ...toConversationDTO(row),
    contentTitle: row.content?.title ?? null,
    service: row.content?.service ?? '',
    sourceRef: row.content?.source_ref ?? '',
  }))
  return { items, hasMore: rows.length > pageSize }
}

export async function listMessages(
  supabase: SupabaseClient,
  conversationId: string,
  page: number,
  pageSize: number,
): Promise<{ items: ChatMessageDTO[]; hasMore: boolean }> {
  const { data, error } = await supabase
    .from('messages')
    .select('id, role, content, citations, created_at')
    .eq('conversation_id', conversationId)
    .order('seq', { ascending: false })
    .range((page - 1) * pageSize, page * pageSize)
  if (error) {
    throw error
  }
  const rows = (data ?? []) as DbMessage[]
  return {
    items: rows.slice(0, pageSize).map(toMessageDTO).reverse(),
    hasMore: rows.length > pageSize,
  }
}

export async function listRecentMessages(
  supabase: SupabaseClient,
  conversationId: string,
  limit: number,
): Promise<Array<{ role: ChatRole; content: string }>> {
  const { data, error } = await supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('seq', { ascending: false })
    .limit(limit)
  if (error) {
    throw error
  }
  return ((data ?? []) as Array<{ role: string; content: string }>)
    .reverse()
    .map((row) => ({ role: row.role === 'assistant' ? 'assistant' : 'user', content: row.content }))
}

/**
 * 一轮问答落库（user + assistant 两条）。仅在流式完整成功后调用，
 * 失败路径不写任何行，保证「半个错误页面」不会持久化。
 */
export async function appendExchange(
  supabase: SupabaseClient,
  userId: string,
  conversationId: string,
  question: string,
  answer: string,
  citations: Citation[],
): Promise<void> {
  const { error: insertError } = await supabase.from('messages').insert([
    { user_id: userId, conversation_id: conversationId, role: 'user', content: question },
    {
      user_id: userId,
      conversation_id: conversationId,
      role: 'assistant',
      content: answer,
      citations,
    },
  ])
  if (insertError) {
    throw insertError
  }
  await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId)
}

/** 清空会话消息（保留会话行本身） */
export async function clearMessages(supabase: SupabaseClient, conversationId: string): Promise<void> {
  const { error } = await supabase.from('messages').delete().eq('conversation_id', conversationId)
  if (error) {
    throw error
  }
}

function toConversationDTO(row: {
  id: string
  content_id: string
  title: string | null
  created_at: string
  updated_at: string
}): ConversationDTO {
  return {
    id: row.id,
    contentId: row.content_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toMessageDTO(row: DbMessage): ChatMessageDTO {
  return {
    id: row.id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    citations: Array.isArray(row.citations) ? row.citations : [],
    createdAt: row.created_at,
  }
}
