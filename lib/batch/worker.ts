import type { SupabaseClient } from '@supabase/supabase-js'
import { commonSubtitlesToSegments, toSummaryConfigSnapshot } from '~/lib/history/adapters'
import { persistSummarizedContent } from '~/lib/history/persist'
import { JobFailureError } from '~/lib/jobs/engine'
import { summarizeFromBuiltRequest } from '~/lib/jobs/summaryJob'
import { classifyUpstreamError } from '~/lib/models/errors'
import { buildSummarizeOpenAIPayload, SummarizeRequestError } from '~/lib/openai/buildSummarizeRequest'
import { parseSourceRef, sourceRefToUrl } from '~/lib/sources/sourceRef'
import { SourceError } from '~/lib/sources/types'
import { VideoService } from '~/lib/types'
import type { VideoConfig } from '~/lib/types'
import { BatchError, RUNNABLE_ITEM_STATUSES } from './types'
import type { BatchItemRow } from './types'

/**
 * 进程内活跃批次注册表：防止同一 collection 被并发驱动两个 worker。
 * 与 lib/jobs/summaryJob 的后台模式一致，仅在自托管长驻进程下可靠。
 */
const activeCollections = new Set<string>()

export function isCollectionBatchActive(collectionId: string): boolean {
  return activeCollections.has(collectionId)
}

function assertNotActive(collectionId: string): void {
  if (activeCollections.has(collectionId)) {
    throw new BatchError('ALREADY_RUNNING', '该批次正在后台执行中，请等待完成或先暂停')
  }
}

async function requireOwnedCollection(supabase: SupabaseClient, userId: string, collectionId: string) {
  const found = await supabase
    .from('collections')
    .select('id, batch_status')
    .eq('id', collectionId)
    .eq('user_id', userId)
    .maybeSingle()
  if (found.error) {
    throw found.error
  }
  if (!found.data) {
    throw new BatchError('NOT_FOUND', `批次不存在：${collectionId}`)
  }
  return found.data as { id: string; batch_status: string }
}

async function requireOwnedItem(supabase: SupabaseClient, userId: string, itemId: string): Promise<BatchItemRow> {
  const found = await supabase.from('collection_items').select('*').eq('id', itemId).eq('user_id', userId).maybeSingle()
  if (found.error) {
    throw found.error
  }
  if (!found.data) {
    throw new BatchError('NOT_FOUND', `批量项不存在：${itemId}`)
  }
  return found.data as BatchItemRow
}

function truncateMessage(message: string): string {
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}

/** 各类上游错误 → item 的 error_code/error_message */
export function classifyItemError(error: unknown): { code: string; message: string } {
  if (error instanceof BatchError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof SummarizeRequestError) {
    // buildSummarizeOpenAIPayload 会把 SourceErrorCode 放进 message 前缀
    const prefixed = /^([A-Z_]+):\s*([\s\S]+)$/.exec(error.message)
    if (prefixed) {
      return { code: prefixed[1], message: prefixed[2] }
    }
    return { code: 'SUMMARY_REQUEST_FAILED', message: error.message }
  }
  if (error instanceof JobFailureError) {
    return { code: error.code, message: error.message }
  }
  if (error instanceof SourceError) {
    return { code: error.code, message: error.message }
  }
  const classified = classifyUpstreamError(error)
  if (classified?.kind) {
    return { code: classified.kind, message: classified.message }
  }
  return { code: 'SUMMARY_FAILED', message: error instanceof Error ? error.message : String(error) }
}

export interface ProcessItemResult {
  contentId: string
  jobId: string | null
  summaryText: string
}

/** 单个批量项的完整摘要链路：只读复用现有管线入口（fetch 字幕 → 摘要 → 落库） */
export async function processBatchItem(
  supabase: SupabaseClient,
  userId: string,
  item: BatchItemRow,
): Promise<ProcessItemResult> {
  const ref = item.dedupe_key ? parseSourceRef(item.dedupe_key) : undefined
  if (!ref) {
    throw new BatchError('INVALID_STATE', `无法从 dedupe_key 解析视频来源：${item.dedupe_key ?? '(empty)'}`)
  }
  const service = ref.service === 'youtube' ? VideoService.Youtube : VideoService.Bilibili
  const pageNumber = ref.pageNumber != null ? String(ref.pageNumber) : null
  const videoConfig: VideoConfig = {
    videoId: ref.videoId,
    service,
    pageNumber,
    enableStream: false,
  }

  const built = await buildSummarizeOpenAIPayload({ videoConfig, userConfig: {} })
  const { text: summaryText, jobId } = await summarizeFromBuiltRequest(built)

  const segments = built.subtitlesArray ? commonSubtitlesToSegments(built.subtitlesArray) : []
  const persisted = await persistSummarizedContent({
    supabase,
    userId,
    media: {
      sourceUrl: item.source_url ?? sourceRefToUrl(item.dedupe_key ?? '') ?? '',
      service: item.service ?? ref.service,
      sourceRef: item.dedupe_key ?? '',
      sourcePage: pageNumber,
      title: built.title ?? item.title ?? null,
      duration: null,
      language: null,
    },
    segments,
    config: toSummaryConfigSnapshot(videoConfig as unknown as Record<string, unknown>),
    model: built.modelTarget.model,
    summaryText,
  })
  return { contentId: persisted.contentId, jobId, summaryText }
}

async function claimItem(
  supabase: SupabaseClient,
  item: BatchItemRow,
  allowedStatuses: ReadonlyArray<BatchItemRow['status']> = RUNNABLE_ITEM_STATUSES,
): Promise<boolean> {
  const updated = await supabase
    .from('collection_items')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
      error_code: null,
      error_message: null,
      attempts: item.attempts + 1,
      job_id: null,
    })
    .eq('id', item.id)
    .in('status', [...allowedStatuses])
    .select('id')
  if (updated.error) {
    throw updated.error
  }
  return (updated.data?.length ?? 0) > 0
}

async function markItemSucceeded(supabase: SupabaseClient, itemId: string, result: ProcessItemResult): Promise<void> {
  const updated = await supabase
    .from('collection_items')
    .update({
      status: 'succeeded',
      content_id: result.contentId,
      job_id: result.jobId,
      finished_at: new Date().toISOString(),
      error_code: null,
      error_message: null,
    })
    .eq('id', itemId)
    .select('id')
  if (updated.error) {
    throw updated.error
  }
}

async function markItemFailed(supabase: SupabaseClient, itemId: string, code: string, message: string): Promise<void> {
  const updated = await supabase
    .from('collection_items')
    .update({
      status: 'failed',
      error_code: code,
      error_message: truncateMessage(message),
      finished_at: new Date().toISOString(),
    })
    .eq('id', itemId)
    .select('id')
  if (updated.error) {
    throw updated.error
  }
}

async function readFreshItem(supabase: SupabaseClient, itemId: string): Promise<BatchItemRow | undefined> {
  const fresh = await supabase.from('collection_items').select('*').eq('id', itemId).maybeSingle()
  if (fresh.error) {
    throw fresh.error
  }
  return (fresh.data as BatchItemRow) ?? undefined
}

async function readBatchStatus(supabase: SupabaseClient, collectionId: string): Promise<string> {
  const row = await supabase.from('collections').select('batch_status').eq('id', collectionId).maybeSingle()
  if (row.error) {
    throw row.error
  }
  return (row.data?.batch_status as string) ?? 'idle'
}

/** 循环结束兜底：仅当仍为 running 时复位为 idle（pause/cancel 设置的状态不覆盖） */
async function settleBatchStatus(supabase: SupabaseClient, collectionId: string): Promise<void> {
  const updated = await supabase
    .from('collections')
    .update({ batch_status: 'idle' })
    .eq('id', collectionId)
    .eq('batch_status', 'running')
    .select('id')
  if (updated.error) {
    throw updated.error
  }
}

async function runBatchLoop(supabase: SupabaseClient, userId: string, collectionId: string): Promise<void> {
  try {
    const pending = await supabase
      .from('collection_items')
      .select('*')
      .eq('collection_id', collectionId)
      .in('status', [...RUNNABLE_ITEM_STATUSES])
      .order('position', { ascending: true })
    if (pending.error) {
      throw pending.error
    }
    const items = (pending.data ?? []) as BatchItemRow[]
    for (const item of items) {
      // pause/cancel：批次状态不再是 running 时停止调度
      const batchStatus = await readBatchStatus(supabase, collectionId)
      if (batchStatus !== 'running') {
        break
      }
      // 项可能已被单项操作改状态（canceled/succeeded/failed），重读后再认领
      const fresh = await readFreshItem(supabase, item.id)
      if (!fresh || !RUNNABLE_ITEM_STATUSES.includes(fresh.status)) {
        continue
      }
      if (!(await claimItem(supabase, fresh))) {
        continue
      }
      try {
        const result = await processBatchItem(supabase, userId, fresh)
        await markItemSucceeded(supabase, fresh.id, result)
      } catch (error) {
        // 单项失败不阻塞其它项：记录后继续下一项
        const { code, message } = classifyItemError(error)
        console.error(`[batch] item ${fresh.id} failed (${code}): ${message}`)
        await markItemFailed(supabase, fresh.id, code, message)
      }
    }
  } finally {
    await settleBatchStatus(supabase, collectionId)
  }
}

export interface StartBatchResult {
  started: boolean
  pendingItems: number
}

/** 开始/续传批次：succeeded/canceled 项跳过，failed 项保留（可单独重试或 retryFailed） */
export async function startBatch(
  supabase: SupabaseClient,
  userId: string,
  collectionId: string,
): Promise<StartBatchResult> {
  await requireOwnedCollection(supabase, userId, collectionId)
  assertNotActive(collectionId)

  const pending = await supabase
    .from('collection_items')
    .select('id')
    .eq('collection_id', collectionId)
    .in('status', [...RUNNABLE_ITEM_STATUSES])
  if (pending.error) {
    throw pending.error
  }
  const pendingItems = pending.data?.length ?? 0
  if (!pendingItems) {
    throw new BatchError('INVALID_STATE', '没有待处理的项（全部已完成或已取消），失败项请使用「重试失败」')
  }

  const updated = await supabase
    .from('collections')
    .update({ batch_status: 'running' })
    .eq('id', collectionId)
    .select('id')
  if (updated.error) {
    throw updated.error
  }

  activeCollections.add(collectionId)
  void runBatchLoop(supabase, userId, collectionId)
    .catch((error: unknown) => {
      console.error(`[batch] collection ${collectionId} loop crashed:`, error)
    })
    .finally(() => {
      activeCollections.delete(collectionId)
    })
  return { started: true, pendingItems }
}

/** 单项开始/重试：批次空闲时单独驱动一项到终态（await 完成） */
export async function runSingleItem(supabase: SupabaseClient, userId: string, itemId: string): Promise<BatchItemRow> {
  const item = await requireOwnedItem(supabase, userId, itemId)
  assertNotActive(item.collection_id)
  if (item.status === 'running') {
    throw new BatchError('INVALID_STATE', '该项正在执行中')
  }
  if (item.status === 'succeeded') {
    throw new BatchError('INVALID_STATE', '该项已完成，无需重试')
  }
  if (!(await claimItem(supabase, item, [...RUNNABLE_ITEM_STATUSES, 'failed', 'canceled']))) {
    throw new BatchError('INVALID_STATE', '该项状态已变化，请刷新后重试')
  }
  try {
    const result = await processBatchItem(supabase, userId, item)
    await markItemSucceeded(supabase, item.id, result)
  } catch (error) {
    const { code, message } = classifyItemError(error)
    console.error(`[batch] item ${item.id} failed (${code}): ${message}`)
    await markItemFailed(supabase, item.id, code, message)
  }
  const updated = await readFreshItem(supabase, itemId)
  if (!updated) {
    throw new BatchError('NOT_FOUND', `批量项不存在：${itemId}`)
  }
  return updated
}

export async function pauseBatch(supabase: SupabaseClient, userId: string, collectionId: string): Promise<void> {
  await requireOwnedCollection(supabase, userId, collectionId)
  const updated = await supabase
    .from('collections')
    .update({ batch_status: 'paused' })
    .eq('id', collectionId)
    .select('id')
  if (updated.error) {
    throw updated.error
  }
}

/** 取消：未开始的项置 canceled；正在执行的当前项自然跑完 */
export async function cancelBatch(supabase: SupabaseClient, userId: string, collectionId: string): Promise<void> {
  await requireOwnedCollection(supabase, userId, collectionId)
  const updated = await supabase
    .from('collections')
    .update({ batch_status: 'idle' })
    .eq('id', collectionId)
    .select('id')
  if (updated.error) {
    throw updated.error
  }
  const canceled = await supabase
    .from('collection_items')
    .update({ status: 'canceled', finished_at: new Date().toISOString() })
    .eq('collection_id', collectionId)
    .in('status', ['pending', 'queued'])
    .select('id')
  if (canceled.error) {
    throw canceled.error
  }
}

export async function retryItem(supabase: SupabaseClient, userId: string, itemId: string): Promise<BatchItemRow> {
  const item = await requireOwnedItem(supabase, userId, itemId)
  if (item.status !== 'failed' && item.status !== 'canceled') {
    throw new BatchError('INVALID_STATE', `仅失败/已取消的项可重试，当前状态：${item.status}`)
  }
  return runSingleItem(supabase, userId, itemId)
}

/** 单项取消：仅未开始的项可取消；正在执行的项由批次状态控制 */
export async function cancelItem(supabase: SupabaseClient, userId: string, itemId: string): Promise<BatchItemRow> {
  const item = await requireOwnedItem(supabase, userId, itemId)
  if (item.status !== 'pending' && item.status !== 'queued') {
    throw new BatchError('INVALID_STATE', `仅未开始的项可取消，当前状态：${item.status}`)
  }
  const updated = await supabase
    .from('collection_items')
    .update({ status: 'canceled', finished_at: new Date().toISOString() })
    .eq('id', item.id)
    .in('status', ['pending', 'queued'])
    .select('*')
    .single()
  if (updated.error) {
    throw updated.error
  }
  return updated.data as BatchItemRow
}

/** 移除单项（不可移除执行中的项） */
export async function removeItem(supabase: SupabaseClient, userId: string, itemId: string): Promise<BatchItemRow> {
  const item = await requireOwnedItem(supabase, userId, itemId)
  if (item.status === 'running') {
    throw new BatchError('INVALID_STATE', '该项正在执行中，请等待完成或先取消批次')
  }
  const deleted = await supabase.from('collection_items').delete().eq('id', item.id).select('*').single()
  if (deleted.error) {
    throw deleted.error
  }
  return deleted.data as BatchItemRow
}

/** 一键重试全部失败项：failed → pending 后按批次续传 */
export async function retryFailedItems(
  supabase: SupabaseClient,
  userId: string,
  collectionId: string,
): Promise<StartBatchResult> {
  await requireOwnedCollection(supabase, userId, collectionId)
  assertNotActive(collectionId)
  const reset = await supabase
    .from('collection_items')
    .update({ status: 'pending', error_code: null, error_message: null, finished_at: null })
    .eq('collection_id', collectionId)
    .eq('status', 'failed')
    .select('id')
  if (reset.error) {
    throw reset.error
  }
  return startBatch(supabase, userId, collectionId)
}

/** 一键清理失败项（从批次中移除） */
export async function clearFailedItems(
  supabase: SupabaseClient,
  userId: string,
  collectionId: string,
): Promise<{ removed: number }> {
  await requireOwnedCollection(supabase, userId, collectionId)
  const deleted = await supabase
    .from('collection_items')
    .delete()
    .eq('collection_id', collectionId)
    .eq('status', 'failed')
    .select('id')
  if (deleted.error) {
    throw deleted.error
  }
  return { removed: deleted.data?.length ?? 0 }
}
