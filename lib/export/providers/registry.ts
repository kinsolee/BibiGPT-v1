// KIN-47 provider 注册表。
import type { ExportProvider, ExportProviderId } from './types'
import { flomoProvider } from './flomo'
import { larkWebhookProvider } from './larkWebhook'
import { notionProvider } from './notion'
import { feishuDocProvider } from './feishuDoc'
import { imaProvider } from './ima'
import { emailProvider } from './email'

const PROVIDERS: Record<ExportProviderId, ExportProvider> = {
  flomo: flomoProvider,
  lark_webhook: larkWebhookProvider,
  notion: notionProvider,
  feishu_doc: feishuDocProvider,
  ima: imaProvider,
  email: emailProvider,
}

export function getProvider(id: string): ExportProvider | null {
  return (PROVIDERS as Record<string, ExportProvider>)[id] ?? null
}

export function listProviders(): ExportProvider[] {
  return Object.values(PROVIDERS)
}
