// KIN-43 视频内 Chat/Ask 类型（客户端与服务端共用，禁止引入服务端依赖）

export type ChatRole = 'user' | 'assistant'

/** 结构化引用：正文中的 [mm:ss] 标记解析回真实 transcript_segment 行 */
export type Citation = {
  segmentId: string
  start: number
  end: number | null
  /** 原文片段（截断） */
  text: string
}

export type ChatMessageDTO = {
  id: string
  role: ChatRole
  content: string
  citations: Citation[]
  createdAt: string
}

/** 客户端定位已保存视频的键（对应 contents 行的唯一约束维度） */
export type ChatSourceKey = {
  service: string
  videoId: string
  pageNumber: string | null
}

export type ConversationDTO = {
  id: string
  contentId: string
  title: string | null
  createdAt: string
  updatedAt: string
}

export type ChatMessagesResponse = {
  items: ChatMessageDTO[]
  page: number
  pageSize: number
  hasMore: boolean
}

/** 超出字幕资料范围时的固定拒答话术 */
export const NO_EVIDENCE_REPLY = '资料中没有依据回答这个问题。'

/** 多轮上下文携带的历史消息条数（≥ 三轮问答） */
export const CHAT_HISTORY_MESSAGE_LIMIT = 8
