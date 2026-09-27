// KIN-47 DOCX 渲染：blocks → docx（docx 包，纯 JS 无原生依赖）。
import * as docx from 'docx'
import { specToBlocks } from './blocks'
import type { ExportBlock } from './blocks'
import type { ExportSpec } from './types'

const { Document, HeadingLevel, Packer, Paragraph, TextRun } = docx

function headingLevel(level: 1 | 2 | 3): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  if (level === 1) {
    return HeadingLevel.HEADING_1
  }
  if (level === 2) {
    return HeadingLevel.HEADING_2
  }
  return HeadingLevel.HEADING_3
}

function blockToDocx(block: ExportBlock): docx.Paragraph {
  switch (block.type) {
    case 'heading':
      return new Paragraph({ heading: headingLevel(block.level), children: [new TextRun(block.text)] })
    case 'paragraph':
      return new Paragraph({ children: [new TextRun(block.text)] })
    case 'bullet':
      return new Paragraph({
        text: block.text,
        bullet: { level: Math.min(block.indent, 8) },
      })
    case 'quote':
      return new Paragraph({
        children: [new TextRun({ text: block.text, color: '555555' })],
        indent: { left: 480 },
        border: { left: { style: docx.BorderStyle.SINGLE, size: 12, color: 'BBBBBB' } },
      })
    case 'meta':
      return new Paragraph({
        children: [new TextRun({ text: `${block.label}：${block.value}`, color: '888888', size: 19 })],
      })
    case 'divider':
      return new Paragraph({
        text: '',
        border: { bottom: { style: docx.BorderStyle.SINGLE, size: 6, color: 'DDDDDD' } },
      })
  }
}

export async function renderDocx(spec: ExportSpec): Promise<Buffer> {
  const doc = new Document({
    sections: [{ properties: {}, children: specToBlocks(spec).map(blockToDocx) }],
  })
  return Packer.toBuffer(doc)
}
