import type { SupabaseClient } from '@supabase/supabase-js'
import { tokenizeQuery } from '~/lib/chat/tokenize'

export type RetrievedSegment = {
  id: string
  idx: number
  start: number | null
  end: number | null
  text: string
}

/** 取该内容最新一份转录的全部 segment（RLS 保证只读到本人数据） */
export async function loadTranscriptSegments(supabase: SupabaseClient, contentId: string): Promise<RetrievedSegment[]> {
  const { data: transcript, error: transcriptError } = await supabase
    .from('transcripts')
    .select('id')
    .eq('content_id', contentId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (transcriptError) {
    throw transcriptError
  }
  if (!transcript) {
    return []
  }
  const { data, error } = await supabase
    .from('transcript_segments')
    .select('id, idx, start, end, text')
    .eq('transcript_id', transcript.id)
    .order('idx', { ascending: true })
  if (error) {
    throw error
  }
  return (data ?? []) as RetrievedSegment[]
}

/** 上下文预算（字符数）：超出的转录按检索窗口裁剪，避免撑爆模型输入 */
const CONTEXT_CHAR_BUDGET = 9000

/** 关键词命中上限；命中段前后各带 1 条相邻 segment 保持语义完整 */
const TOP_K_SEGMENTS = 16

/**
 * 轻量检索窗口：短转录全文进入上下文；长转录按问题关键词打分取 top-K
 * 及其相邻段。无任何命中时回退为转录开头，保证模型始终有真实资料可引用。
 */
export function selectContextWindow(
  question: string,
  segments: RetrievedSegment[],
  budgetChars: number = CONTEXT_CHAR_BUDGET,
): RetrievedSegment[] {
  if (segments.length === 0) {
    return []
  }
  const totalChars = segments.reduce((sum, segment) => sum + segment.text.length + 12, 0)
  if (totalChars <= budgetChars) {
    return segments
  }

  const terms = tokenizeQuery(question)
  const lowerTexts = segments.map((segment) => segment.text.toLowerCase())
  const scores = lowerTexts.map((text) => terms.reduce((score, term) => score + countOccurrences(text, term), 0))

  const ranked = scores
    .map((score, idx) => ({ score, idx }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K_SEGMENTS)

  if (ranked.length === 0) {
    return takeFromStart(segments, budgetChars)
  }

  const candidateIdx = new Set<number>()
  for (const { idx } of ranked) {
    candidateIdx.add(idx)
    if (idx > 0) {
      candidateIdx.add(idx - 1)
    }
    if (idx < segments.length - 1) {
      candidateIdx.add(idx + 1)
    }
  }
  const ordered = Array.from(candidateIdx).sort((a, b) => a - b)
  const window: RetrievedSegment[] = []
  let used = 0
  for (const idx of ordered) {
    const segment = segments[idx]
    const cost = segment.text.length + 12
    if (used + cost > budgetChars && window.length > 0) {
      break
    }
    window.push(segment)
    used += cost
  }
  return window
}

function takeFromStart(segments: RetrievedSegment[], budgetChars: number): RetrievedSegment[] {
  const window: RetrievedSegment[] = []
  let used = 0
  for (const segment of segments) {
    const cost = segment.text.length + 12
    if (used + cost > budgetChars && window.length > 0) {
      break
    }
    window.push(segment)
    used += cost
  }
  return window
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0
  }
  let count = 0
  let cursor = haystack.indexOf(needle)
  while (cursor !== -1) {
    count += 1
    cursor = haystack.indexOf(needle, cursor + needle.length)
  }
  return count
}
