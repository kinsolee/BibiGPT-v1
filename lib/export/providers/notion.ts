// KIN-47 Notion provider（真实实现）：凭据走 env（NOTION_TOKEN / NOTION_DATABASE_ID），
// 也可在集成配置里覆盖 databaseId / token。块数超 100 自动分批 append。
import { ExportError } from '../errors'
import { specToBlocks } from '../blocks'
import type { ExportBlock } from '../blocks'
import type { ExportSpec } from '../types'
import { assertProviderOk, postJson, type ExportProvider, type ProviderContext } from './types'

const NOTION_API = 'https://api.notion.com/v1'
const NOTION_VERSION = '2022-06-28'
const CHILDREN_BATCH = 90
const RICH_TEXT_MAX = 1900

function notionToken(ctx: ProviderContext): string {
  const fromCtx = typeof ctx.secret === 'string' ? ctx.secret.trim() : ''
  return fromCtx || (process.env.NOTION_TOKEN ?? '').trim()
}

function notionDatabaseId(ctx: ProviderContext): string {
  const fromCtx = typeof ctx.config.databaseId === 'string' ? ctx.config.databaseId.trim() : ''
  return fromCtx || (process.env.NOTION_DATABASE_ID ?? '').trim()
}

function richText(text: string) {
  const chunks: string[] = []
  let rest = text
  while (rest.length > RICH_TEXT_MAX) {
    chunks.push(rest.slice(0, RICH_TEXT_MAX))
    rest = rest.slice(RICH_TEXT_MAX)
  }
  chunks.push(rest)
  return chunks.map((content) => ({ text: { content } }))
}

function blockToNotion(block: ExportBlock): Record<string, unknown> | null {
  const object = { object: 'block' } as Record<string, unknown>
  switch (block.type) {
    case 'heading':
      return {
        ...object,
        type: `heading_${block.level}`,
        [`heading_${block.level}`]: { rich_text: richText(block.text) },
      }
    case 'paragraph':
      return { ...object, type: 'paragraph', paragraph: { rich_text: richText(block.text) } }
    case 'bullet':
      return { ...object, type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(block.text) } }
    case 'quote':
      return { ...object, type: 'quote', quote: { rich_text: richText(block.text) } }
    case 'meta':
      return {
        ...object,
        type: 'paragraph',
        paragraph: { rich_text: richText(`${block.label}：${block.value}`) },
      }
    case 'divider':
      return { ...object, type: 'paragraph', paragraph: { rich_text: [] } }
  }
}

function specToNotionChildren(spec: ExportSpec): Array<Record<string, unknown>> {
  return specToBlocks(spec)
    .map(blockToNotion)
    .filter((block): block is Record<string, unknown> => block !== null)
}

export const notionProvider: ExportProvider = {
  id: 'notion',
  displayName: 'Notion',
  kind: 'app',
  secretLabel: null,
  configFields: [{ key: 'databaseId', label: 'Notion Database ID（可选，缺省读 NOTION_DATABASE_ID）' }],
  envConfigured: () =>
    Boolean((process.env.NOTION_TOKEN ?? '').trim() && (process.env.NOTION_DATABASE_ID ?? '').trim()),
  deliver: async (spec: ExportSpec, ctx: ProviderContext) => {
    const token = notionToken(ctx)
    const databaseId = notionDatabaseId(ctx)
    if (!token || !databaseId) {
      throw new ExportError(
        'config_missing',
        400,
        'Notion 未配置：需要 NOTION_TOKEN / NOTION_DATABASE_ID 或集成配置覆盖',
      )
    }
    const headers = { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION }
    const children = specToNotionChildren(spec)
    const firstBatch = children.slice(0, CHILDREN_BATCH)

    const created = await postJson(
      `${NOTION_API}/pages`,
      {
        parent: { database_id: databaseId },
        properties: { title: { title: richText(spec.title) } },
        children: firstBatch,
      },
      headers,
    )
    assertProviderOk(
      created.status >= 200 && created.status < 300 && created.json?.id,
      `Notion 建页失败（HTTP ${created.status}）`,
    )
    const pageId: string = created.json.id
    const pageUrl: string | null = typeof created.json.url === 'string' ? created.json.url : null

    for (let offset = CHILDREN_BATCH; offset < children.length; offset += CHILDREN_BATCH) {
      const appended = await postJson(
        `${NOTION_API}/blocks/${pageId}/children`,
        { children: children.slice(offset, offset + CHILDREN_BATCH) },
        headers,
      )
      assertProviderOk(appended.status >= 200 && appended.status < 300, `Notion 追加块失败（HTTP ${appended.status}）`)
    }
    return { externalId: pageId, externalUrl: pageUrl }
  },
}
