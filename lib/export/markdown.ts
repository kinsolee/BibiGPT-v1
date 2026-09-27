// KIN-47 Markdown 渲染：blocks → markdown 文本。
import { specToBlocks } from './blocks'
import type { ExportBlock } from './blocks'
import type { ExportSpec } from './types'

function blockToMarkdown(block: ExportBlock): string {
  switch (block.type) {
    case 'heading':
      return `${'#'.repeat(block.level)} ${block.text}`
    case 'paragraph':
      return block.text
    case 'bullet':
      return `${'  '.repeat(block.indent)}- ${block.text}`
    case 'quote':
      return `> ${block.text}`
    case 'meta':
      return `- **${block.label}**: ${block.value}`
    case 'divider':
      return '---'
  }
}

export function renderMarkdown(spec: ExportSpec): string {
  return specToBlocks(spec).map(blockToMarkdown).join('\n\n') + '\n'
}
