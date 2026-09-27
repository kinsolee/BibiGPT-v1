// KIN-47 导出 provider interface：flomo / lark_webhook / notion / feishu_doc 真实实现，
// ima / email 为保留接口（结构化 NOT_IMPLEMENTED，自用版降级口径）。
import { ExportError } from '../errors'
import { redactSecrets } from '~/lib/models/errors'
import type { ExportSpec } from '../types'

export type ExportProviderId = 'flomo' | 'lark_webhook' | 'notion' | 'feishu_doc' | 'ima' | 'email'

export const EXPORT_PROVIDER_IDS: ExportProviderId[] = ['flomo', 'lark_webhook', 'notion', 'feishu_doc', 'ima', 'email']

export function isExportProviderId(value: unknown): value is ExportProviderId {
  return typeof value === 'string' && (EXPORT_PROVIDER_IDS as string[]).includes(value)
}

export type ProviderConfigField = {
  key: string
  label: string
  required?: boolean
  placeholder?: string
}

export type ProviderContext = {
  /** 非敏感配置（存 export_integrations.config 或 env 回落） */
  config: Record<string, unknown>
  /** 敏感凭据（webhook URL / token），解密后仅在服务端内存中出现 */
  secret: string | null
}

export type ProviderDeliveryResult = {
  externalId?: string | null
  externalUrl?: string | null
}

export type ExportProvider = {
  id: ExportProviderId
  displayName: string
  kind: 'webhook' | 'app' | 'unimplemented'
  /** 需要用户配置的敏感凭据说明；null 表示凭据走 env */
  secretLabel: string | null
  configFields: ProviderConfigField[]
  /** env 凭据是否已配置（notion / feishu_doc） */
  envConfigured: () => boolean
  deliver: (spec: ExportSpec, ctx: ProviderContext) => Promise<ProviderDeliveryResult>
}

export function requireSecret(ctx: ProviderContext): string {
  const secret = ctx.secret?.trim()
  if (!secret) {
    throw new ExportError('secret_missing', 400, '该集成尚未配置凭据')
  }
  return secret
}

export function requireConfigString(ctx: ProviderContext, key: string): string {
  const value = ctx.config[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new ExportError('config_missing', 400, `集成配置缺少 ${key}`)
  }
  return value.trim()
}

const FETCH_TIMEOUT_MS = 20000

/** provider 出站请求统一封装：超时、错误脱敏，URL 不进日志 */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ExportError('provider_unreachable', 502, `第三方服务不可达：${redactSecrets(message)}`)
  }
  const json = await response.json().catch(() => null)
  return { status: response.status, json }
}

export function assertProviderOk(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new ExportError('provider_failed', 502, redactSecrets(message))
  }
}
