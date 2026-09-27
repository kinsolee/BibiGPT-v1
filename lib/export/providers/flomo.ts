// KIN-47 flomo provider：服务端化原有浏览器直发逻辑（hooks/notes/flomo.ts 同构）。
// webhook URL 属 secret，AES-256-GCM 加密存库，仅在 deliver 时解密使用。
import { ExportError } from '../errors'
import type { ExportSpec } from '../types'
import { assertProviderOk, postJson, requireSecret, type ExportProvider, type ProviderContext } from './types'

/** flomo 便签正文：摘要 + 原链接（与原浏览器端行为一致，不含整段字幕） */
export function buildFlomoContent(spec: ExportSpec): string {
  const summary = spec.summary?.trim() || ''
  return `${spec.title}\n\n${summary}\n\n原视频：${spec.sourceUrl ?? ''}\n#BibiGPT`.trim()
}

export function validateFlomoWebhook(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ExportError('invalid_webhook', 400, 'flomo Webhook 不是合法 URL')
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'flomoapp.com' || !parsed.pathname.startsWith('/iwh/')) {
    throw new ExportError('invalid_webhook', 400, 'flomo Webhook 必须是 https://flomoapp.com/iwh/ 开头的链接')
  }
  return parsed.toString()
}

export const flomoProvider: ExportProvider = {
  id: 'flomo',
  displayName: 'Flomo 浮墨笔记',
  kind: 'webhook',
  secretLabel: 'flomo API Webhook 链接（https://flomoapp.com/iwh/...）',
  configFields: [],
  envConfigured: () => false,
  deliver: async (spec: ExportSpec, ctx: ProviderContext) => {
    const webhook = validateFlomoWebhook(requireSecret(ctx))
    const { status, json } = await postJson(webhook, { content: buildFlomoContent(spec) })
    assertProviderOk(status >= 200 && status < 300 && json?.code !== -1, `flomo 保存失败（HTTP ${status}）`)
    return { externalId: null, externalUrl: 'https://v.flomoapp.com/mine' }
  },
}
