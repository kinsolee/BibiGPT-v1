// KIN-47 飞书文档（docx）provider（真实实现）：凭据走 env（FEISHU_APP_ID / FEISHU_APP_SECRET），
// 可选 FEISHU_DOC_FOLDER_TOKEN 指定云空间目录。tenant_access_token 每次投递现取现用，不落库。
import { ExportError } from '../errors'
import { specToBlocks } from '../blocks'
import type { ExportBlock } from '../blocks'
import type { ExportSpec } from '../types'
import { assertProviderOk, postJson, type ExportProvider, type ProviderContext } from './types'

const FEISHU_BASE = process.env.FEISHU_API_BASE || 'https://open.feishu.cn'
const BLOCKS_BATCH = 50

function feishuAppCredentials(ctx: ProviderContext): { appId: string; appSecret: string } {
  const appId =
    (typeof ctx.config.appId === 'string' ? ctx.config.appId.trim() : '') || (process.env.FEISHU_APP_ID ?? '').trim()
  const appSecret = (ctx.secret ?? '').trim() || (process.env.FEISHU_APP_SECRET ?? '').trim()
  return { appId, appSecret }
}

function elementsOf(text: string) {
  return [{ text_run: { content: text } }]
}

/** 仅使用飞书确定稳定的块类型：text=2 / heading1-3=3-5 / bullet=12；quote 以「引用：」文本替代 */
function blockToFeishu(block: ExportBlock): Record<string, unknown> | null {
  const text = block.type === 'meta' ? `${block.label}：${block.value}` : 'text' in block ? block.text : null
  if (text === null) {
    return null
  }
  switch (block.type) {
    case 'heading':
      return {
        block_type: 2 + block.level,
        [`heading${block.level}`]: { elements: elementsOf(block.text), style: {} },
      }
    case 'bullet':
      return { block_type: 12, bullet: { elements: elementsOf(text), style: {} } }
    case 'quote':
      return { block_type: 2, text: { elements: elementsOf(`引用：${text}`), style: {} } }
    case 'divider':
      return null
    default:
      return { block_type: 2, text: { elements: elementsOf(text), style: {} } }
  }
}

async function fetchTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const { status, json } = await postJson(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    app_id: appId,
    app_secret: appSecret,
  })
  assertProviderOk(
    status >= 200 && status < 300 && json?.code === 0 && json?.tenant_access_token,
    `飞书获取 tenant_access_token 失败（HTTP ${status}）`,
  )
  return json.tenant_access_token as string
}

async function createDocument(token: string, title: string): Promise<string> {
  const folderToken = (process.env.FEISHU_DOC_FOLDER_TOKEN ?? '').trim()
  const { status, json } = await postJson(
    `${FEISHU_BASE}/open-apis/docx/v1/documents`,
    { title, folder_token: folderToken || undefined },
    { Authorization: `Bearer ${token}` },
  )
  assertProviderOk(
    status >= 200 && status < 300 && json?.code === 0 && json?.data?.document?.document_id,
    `飞书创建文档失败（HTTP ${status}）`,
  )
  return json.data.document.document_id as string
}

async function appendBlocks(token: string, documentId: string, blocks: Array<Record<string, unknown>>): Promise<void> {
  for (let offset = 0; offset < blocks.length; offset += BLOCKS_BATCH) {
    const batch = blocks.slice(offset, offset + BLOCKS_BATCH)
    const { status, json } = await postJson(
      `${FEISHU_BASE}/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children?document_revision_id=-1`,
      { children: batch, index: -1 },
      { Authorization: `Bearer ${token}` },
    )
    assertProviderOk(status >= 200 && status < 300 && json?.code === 0, `飞书写入块失败（HTTP ${status}）`)
  }
}

export const feishuDocProvider: ExportProvider = {
  id: 'feishu_doc',
  displayName: '飞书文档',
  kind: 'app',
  secretLabel: null,
  configFields: [{ key: 'appId', label: '飞书自建应用 App ID（可选，缺省读 FEISHU_APP_ID）' }],
  envConfigured: () =>
    Boolean((process.env.FEISHU_APP_ID ?? '').trim() && (process.env.FEISHU_APP_SECRET ?? '').trim()),
  deliver: async (spec: ExportSpec, ctx: ProviderContext) => {
    const { appId, appSecret } = feishuAppCredentials(ctx)
    if (!appId || !appSecret) {
      throw new ExportError(
        'config_missing',
        400,
        '飞书文档未配置：需要 FEISHU_APP_ID / FEISHU_APP_SECRET 或集成配置覆盖',
      )
    }
    const token = await fetchTenantAccessToken(appId, appSecret)
    const documentId = await createDocument(token, spec.title)
    const blocks = specToBlocks(spec)
      .map(blockToFeishu)
      .filter((block): block is Record<string, unknown> => block !== null)
    await appendBlocks(token, documentId, blocks)
    return { externalId: documentId, externalUrl: `https://www.feishu.cn/docx/${documentId}` }
  },
}
