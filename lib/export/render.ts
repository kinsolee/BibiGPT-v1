// KIN-47 渲染分发：format → 字节流 + 元信息。
import { renderJson } from './json'
import { renderMarkdown } from './markdown'
import { renderPdf } from './pdf'
import { renderDocx } from './docx'
import type { ExportFormat, ExportSpec } from './types'

const MIME_BY_FORMAT: Record<ExportFormat, string> = {
  markdown: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

const EXT_BY_FORMAT: Record<ExportFormat, string> = {
  markdown: 'md',
  json: 'json',
  pdf: 'pdf',
  docx: 'docx',
}

export function mimeByFormat(format: ExportFormat): string {
  return MIME_BY_FORMAT[format]
}

export function buildExportFilename(spec: ExportSpec, format: ExportFormat): string {
  const base =
    (spec.title || 'export')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
      .trim()
      .slice(0, 60) || 'export'
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `${base}-${date}.${EXT_BY_FORMAT[format]}`
}

export async function renderExport(
  spec: ExportSpec,
  format: ExportFormat,
): Promise<{ body: Uint8Array | Buffer; mime: string; filename: string }> {
  const filename = buildExportFilename(spec, format)
  switch (format) {
    case 'markdown':
      return { body: Buffer.from(renderMarkdown(spec), 'utf8'), mime: MIME_BY_FORMAT.markdown, filename }
    case 'json':
      return { body: Buffer.from(renderJson(spec), 'utf8'), mime: MIME_BY_FORMAT.json, filename }
    case 'pdf':
      return { body: await renderPdf(spec), mime: MIME_BY_FORMAT.pdf, filename }
    case 'docx':
      return { body: await renderDocx(spec), mime: MIME_BY_FORMAT.docx, filename }
  }
}
