// KIN-47 导出服务编排：集成配置（secret 加密存库）、投递、重试、撤销、审计。
// 约束：secret 明文只在内存中出现；错误信息经 redactSecrets 后才落库/进日志。
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptSecret, encryptSecret } from './crypto'
import { ExportError, toExportError } from './errors'
import { buildExportSpec, resolveContentRow, type BuildSpecParams } from './spec'
import { getProvider, listProviders } from './providers/registry'
import { validateFlomoWebhook } from './providers/flomo'
import { validateLarkWebhook } from './providers/larkWebhook'
import type { ExportProviderId } from './providers/types'
import type { ExportDeliveryDTO, ExportIntegrationDTO, ExportSpec } from './types'

type IntegrationRow = {
  id: string
  user_id: string
  provider: string
  display_name: string | null
  config: Record<string, unknown>
  secret_encrypted: string | null
  status: 'active' | 'disabled'
  created_at: string
  updated_at: string
}

type DeliveryRow = {
  id: string
  user_id: string
  integration_id: string | null
  content_id: string
  provider: string
  status: 'succeeded' | 'failed'
  attempts: number
  last_error_code: string | null
  last_error_message: string | null
  external_url: string | null
  created_at: string
  updated_at: string
}

const WEBHOOK_PROVIDERS: ExportProviderId[] = ['flomo', 'lark_webhook']

export async function auditAction(
  supabase: SupabaseClient,
  userId: string,
  action: string,
  refs: { contentId?: string | null; provider?: string | null; metadata?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    const { error } = await supabase.from('export_audit_logs').insert({
      user_id: userId,
      action,
      content_id: refs.contentId ?? null,
      provider: refs.provider ?? null,
      metadata: refs.metadata ?? {},
    })
    if (error) {
      throw error
    }
  } catch (error) {
    console.error('export audit failed:', error instanceof Error ? error.message : error)
  }
}

export function providerMeta() {
  return listProviders().map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    kind: provider.kind,
    secretLabel: provider.secretLabel,
    configFields: provider.configFields,
    envConfigured: provider.envConfigured(),
  }))
}

export async function listIntegrations(supabase: SupabaseClient, userId: string): Promise<ExportIntegrationDTO[]> {
  const { data, error } = await supabase
    .from('export_integrations')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
  if (error) {
    throw error
  }
  return ((data ?? []) as IntegrationRow[]).map((row) => ({
    provider: row.provider,
    displayName: row.display_name,
    status: row.status,
    hasSecret: Boolean(row.secret_encrypted),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }))
}

export async function upsertIntegration(
  supabase: SupabaseClient,
  userId: string,
  input: { provider: ExportProviderId; secret: string; displayName?: string | null },
): Promise<ExportIntegrationDTO> {
  const provider = getProvider(input.provider)
  if (!provider) {
    throw new ExportError('unsupported_provider', 400, `不支持的集成类型：${input.provider}`)
  }
  if (provider.kind === 'unimplemented') {
    throw new ExportError('not_implemented', 501, `${provider.displayName} 尚未实现，无法配置`)
  }
  if (!WEBHOOK_PROVIDERS.includes(input.provider)) {
    throw new ExportError('env_only_provider', 400, `${provider.displayName} 的凭据走服务端 env，无需在集成里存储`)
  }
  // webhook URL 归属校验（防 SSRF：仅允许官方域）
  const normalizedSecret =
    input.provider === 'flomo' ? validateFlomoWebhook(input.secret) : validateLarkWebhook(input.secret)

  const row = {
    user_id: userId,
    provider: input.provider,
    display_name: input.displayName ?? null,
    config: {},
    secret_encrypted: encryptSecret(normalizedSecret),
    status: 'active' as const,
    updated_at: new Date().toISOString(),
  }
  const { data, error } = await supabase
    .from('export_integrations')
    .upsert(row, { onConflict: 'user_id,provider' })
    .select('*')
    .single()
  if (error) {
    throw error
  }
  const saved = data as IntegrationRow
  await auditAction(supabase, userId, 'integration_upsert', { provider: input.provider })
  return {
    provider: saved.provider,
    displayName: saved.display_name,
    status: saved.status,
    hasSecret: Boolean(saved.secret_encrypted),
    createdAt: saved.created_at,
    updatedAt: saved.updated_at,
  }
}

export async function revokeIntegration(supabase: SupabaseClient, userId: string, provider: string): Promise<void> {
  const { data, error } = await supabase
    .from('export_integrations')
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider)
    .select('id')
  if (error) {
    throw error
  }
  await auditAction(supabase, userId, 'integration_revoke', { provider })
  if (!data?.length) {
    throw new ExportError('integration_not_found', 404, '该集成不存在')
  }
}

async function loadIntegrationRow(
  supabase: SupabaseClient,
  userId: string,
  provider: ExportProviderId,
): Promise<IntegrationRow | null> {
  const { data, error } = await supabase
    .from('export_integrations')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle()
  if (error) {
    throw error
  }
  return (data as IntegrationRow | null) ?? null
}

async function resolveProviderContext(
  supabase: SupabaseClient,
  userId: string,
  provider: ExportProviderId,
): Promise<{ config: Record<string, unknown>; secret: string | null; integrationId: string | null }> {
  const row = await loadIntegrationRow(supabase, userId, provider)
  if (row?.status === 'disabled') {
    throw new ExportError('integration_disabled', 409, '该集成已停用')
  }
  let secret: string | null = null
  if (row?.secret_encrypted) {
    try {
      secret = decryptSecret(row.secret_encrypted)
    } catch {
      throw new ExportError('secret_decrypt_failed', 500, '集成凭据解密失败，请重新配置该集成')
    }
  }
  return { config: row?.config ?? {}, secret, integrationId: row?.id ?? null }
}

function deliveryRowToDTO(row: DeliveryRow): ExportDeliveryDTO {
  return {
    id: row.id,
    provider: row.provider,
    contentId: row.content_id,
    status: row.status,
    attempts: row.attempts,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    externalUrl: row.external_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

async function runDelivery(
  supabase: SupabaseClient,
  userId: string,
  input: { spec: ExportSpec; contentId: string; provider: ExportProviderId },
): Promise<ExportDeliveryDTO> {
  const providerDef = getProvider(input.provider)
  if (!providerDef) {
    throw new ExportError('unsupported_provider', 400, `不支持的集成类型：${input.provider}`)
  }
  const { config, secret, integrationId } = await resolveProviderContext(supabase, userId, input.provider)

  let delivery: DeliveryRow
  try {
    const result = await providerDef.deliver(input.spec, { config, secret })
    const inserted = await supabase
      .from('export_deliveries')
      .insert({
        user_id: userId,
        integration_id: integrationId ?? null,
        content_id: input.contentId,
        provider: input.provider,
        status: 'succeeded',
        attempts: 1,
        external_url: result.externalUrl ?? null,
      })
      .select('*')
      .single()
    if (inserted.error) {
      throw inserted.error
    }
    delivery = inserted.data as DeliveryRow
  } catch (error) {
    const exportError = toExportError(error, 'provider_failed')
    const inserted = await supabase
      .from('export_deliveries')
      .insert({
        user_id: userId,
        integration_id: integrationId ?? null,
        content_id: input.contentId,
        provider: input.provider,
        status: 'failed',
        attempts: 1,
        last_error_code: exportError.code,
        last_error_message: exportError.message.slice(0, 500),
      })
      .select('*')
      .single()
    if (inserted.error) {
      console.error('export delivery record failed:', inserted.error.message)
    }
    delivery = inserted.data as DeliveryRow
    throw exportError
  }

  await auditAction(supabase, userId, 'deliver', {
    contentId: input.contentId,
    provider: input.provider,
    metadata: { attempts: delivery.attempts },
  })
  return deliveryRowToDTO(delivery)
}

export async function deliverToProvider(
  supabase: SupabaseClient,
  userId: string,
  input: BuildSpecParams & { provider: ExportProviderId },
): Promise<ExportDeliveryDTO> {
  const content = await resolveContentRow(supabase, userId, input)
  if (!content) {
    throw new ExportError('content_not_found', 404, '内容不存在或不属于当前用户')
  }
  const spec = await buildExportSpec(supabase, userId, input)
  return runDelivery(supabase, userId, {
    spec,
    contentId: content.id,
    provider: input.provider,
  })
}

export async function retryDelivery(
  supabase: SupabaseClient,
  userId: string,
  deliveryId: string,
): Promise<ExportDeliveryDTO> {
  const { data, error } = await supabase
    .from('export_deliveries')
    .select('id, content_id, provider')
    .eq('id', deliveryId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error) {
    throw error
  }
  const previous = (data as { id: string; content_id: string; provider: string } | null) ?? null
  if (!previous) {
    throw new ExportError('delivery_not_found', 404, '投递记录不存在')
  }
  // 每次尝试落一行历史；重试 = 以原 content 重新投递
  const spec = await buildExportSpec(supabase, userId, { contentId: previous.content_id })
  return runDelivery(supabase, userId, {
    spec,
    contentId: previous.content_id,
    provider: previous.provider as ExportProviderId,
  })
}

export async function listDeliveries(
  supabase: SupabaseClient,
  userId: string,
  input: BuildSpecParams & { limit?: number },
): Promise<ExportDeliveryDTO[]> {
  let contentId = input.contentId ?? null
  if (!contentId) {
    const content = await resolveContentRow(supabase, userId, input)
    contentId = content?.id ?? null
  }
  const query = supabase
    .from('export_deliveries')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(input.limit ?? 10, 1), 50))
  const scoped = contentId ? await query.eq('content_id', contentId) : await query
  if (scoped.error) {
    throw scoped.error
  }
  return ((scoped.data ?? []) as DeliveryRow[]).map(deliveryRowToDTO)
}
