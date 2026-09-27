// KIN-47 飞书 Webhook provider：服务端化原有浏览器直发逻辑（hooks/notes/lark.ts 同构卡片）。
import { ExportError } from '../errors'
import type { ExportSpec } from '../types'
import { assertProviderOk, postJson, requireSecret, type ExportProvider, type ProviderContext } from './types'

export function validateLarkWebhook(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ExportError('invalid_webhook', 400, '飞书 Webhook 不是合法 URL')
  }
  const allowedHosts = new Set(['open.feishu.cn', 'open.larksuite.com'])
  if (
    parsed.protocol !== 'https:' ||
    !allowedHosts.has(parsed.hostname) ||
    !parsed.pathname.startsWith('/open-apis/bot/v2/hook/')
  ) {
    throw new ExportError(
      'invalid_webhook',
      400,
      '飞书 Webhook 必须是 open.feishu.cn / open.larksuite.com 的 /open-apis/bot/v2/hook/ 链接',
    )
  }
  return parsed.toString()
}

function buildLarkCard(spec: ExportSpec) {
  const note = spec.summary?.trim() || spec.title
  return {
    msg_type: 'interactive',
    card: {
      elements: [
        {
          tag: 'div',
          text: { content: note, tag: 'plain_text' },
        },
        {
          tag: 'note',
          elements: [{ tag: 'plain_text', content: `原视频：${spec.sourceUrl ?? ''}` }],
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '观看视频' },
              type: 'primary',
              multi_url: { url: spec.sourceUrl ?? '' },
            },
          ],
        },
      ],
      header: {
        template: 'blue',
        title: { content: `BibiGPT 视频摘要：${spec.title}`, tag: 'plain_text' },
      },
    },
  }
}

export const larkWebhookProvider: ExportProvider = {
  id: 'lark_webhook',
  displayName: '飞书 / Lark Webhook',
  kind: 'webhook',
  secretLabel: '飞书群机器人 Webhook 链接（open.feishu.cn/open-apis/bot/v2/hook/...）',
  configFields: [],
  envConfigured: () => false,
  deliver: async (spec: ExportSpec, ctx: ProviderContext) => {
    const webhook = validateLarkWebhook(requireSecret(ctx))
    const { status, json } = await postJson(webhook, buildLarkCard(spec))
    assertProviderOk(status >= 200 && status < 300 && json?.code === 0, `飞书 Webhook 返回失败（HTTP ${status}）`)
    return { externalId: null, externalUrl: null }
  },
}
