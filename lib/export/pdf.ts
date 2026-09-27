// KIN-47 PDF 渲染：blocks → PDF（pdf-lib）。
// 分页规则：分页只发生在块内「行与行」之间或块与块之间；换行只发生在
// 字素簇（grapheme）/西文单词边界，不切断 glyph、emoji、 surrogate pair。
// 标题块禁止成为页尾孤行（其后至少保留 2 行正文空间）。
import * as fs from 'node:fs'
import * as pdfLib from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import { specToBlocks } from './blocks'
import type { ExportBlock } from './blocks'
import type { ExportSpec } from './types'

type PdfFont = pdfLib.PDFFont

const PAGE = { width: 595.28, height: 841.89 }
const MARGIN = { top: 60, bottom: 68, left: 56, right: 56 }
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right
const BODY_SIZE = 10.5
const BODY_LINE_HEIGHT = BODY_SIZE * 1.6

type TextStyle = {
  size: number
  lineHeight: number
  gray: number
  indent: number
  bold: boolean
  spaceBefore: number
  spaceAfter: number
}

const STYLES: Record<string, TextStyle> = {
  heading: {
    size: BODY_SIZE,
    lineHeight: BODY_SIZE * 1.4,
    gray: 0.1,
    indent: 0,
    bold: true,
    spaceBefore: 12,
    spaceAfter: 7,
  },
  paragraph: {
    size: BODY_SIZE,
    lineHeight: BODY_LINE_HEIGHT,
    gray: 0.13,
    indent: 0,
    bold: false,
    spaceBefore: 0,
    spaceAfter: 6,
  },
  bullet: {
    size: BODY_SIZE,
    lineHeight: BODY_LINE_HEIGHT,
    gray: 0.13,
    indent: 16,
    bold: false,
    spaceBefore: 0,
    spaceAfter: 3,
  },
  quote: {
    size: BODY_SIZE,
    lineHeight: BODY_LINE_HEIGHT,
    gray: 0.35,
    indent: 16,
    bold: false,
    spaceBefore: 0,
    spaceAfter: 3,
  },
  meta: { size: 9.5, lineHeight: 9.5 * 1.5, gray: 0.45, indent: 0, bold: false, spaceBefore: 0, spaceAfter: 2 },
  divider: { size: 0, lineHeight: 0, gray: 0.85, indent: 0, bold: false, spaceBefore: 8, spaceAfter: 8 },
}

const HEADING_SIZES: Record<1 | 2 | 3, number> = { 1: 20, 2: 15, 3: 12.5 }

// ---------------------------------------------------------------- 字素级分词与断行

/** 按字素簇切分（emoji ZWJ 序列、变体选择子都不可分）；无 Intl.Segmenter 时回落 code point */
export function splitGraphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof (Intl as any).Segmenter === 'function') {
    const segmenter = new (Intl as any).Segmenter(undefined, { granularity: 'grapheme' })
    return Array.from(segmenter.segment(text), (seg: { segment: string }) => seg.segment)
  }
  return Array.from(text)
}

const NO_BREAK_BEFORE = new Set('，。、；：！？）》〉」』】〕…％‰·’”'.split(''))
const NO_BREAK_AFTER = new Set('（《〈「『【〔‘“'.split(''))

export type Token = {
  text: string
  space: boolean
  /** 断行允许出现在该 token 之后 / 之前 */
  breakAfter: boolean
  breakBefore: boolean
}

/** 文本 → 不可再分的断行单元：字素簇（CJK 单字、emoji 等）或西文连续单词 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let wordRun = ''
  const flushWord = () => {
    if (wordRun) {
      tokens.push({ text: wordRun, space: false, breakAfter: true, breakBefore: true })
      wordRun = ''
    }
  }
  for (const grapheme of splitGraphemes(text)) {
    if (/\s/.test(grapheme)) {
      flushWord()
      tokens.push({ text: ' ', space: true, breakAfter: true, breakBefore: true })
      continue
    }
    if (/[A-Za-z0-9]/.test(grapheme) && grapheme.length === 1) {
      wordRun += grapheme
      continue
    }
    flushWord()
    // CJK/全角单字：任意可断，但闭合标点不得出现在行首、开放标点不得出现在行尾
    const isClosing = NO_BREAK_BEFORE.has(grapheme)
    const isOpening = NO_BREAK_AFTER.has(grapheme)
    tokens.push({ text: grapheme, space: false, breakAfter: !isOpening, breakBefore: !isClosing })
  }
  flushWord()
  return tokens
}

type MeasuredToken = Token & { width: number }

/** 粘连不可断 token（闭合标点挂前字 / 开放标点带后字）成原子块，换行只发生在块之间 */
function mergeChunks(tokens: MeasuredToken[]): MeasuredToken[][] {
  const chunks: MeasuredToken[][] = []
  let chunk: MeasuredToken[] = []
  for (const token of tokens) {
    if (!chunk.length) {
      chunk = [token]
      continue
    }
    const prev = chunk[chunk.length - 1]
    if (!token.breakBefore || !prev.breakAfter) {
      chunk.push(token)
    } else {
      chunks.push(chunk)
      chunk = [token]
    }
  }
  if (chunk.length) {
    chunks.push(chunk)
  }
  return chunks
}

const chunkWidth = (chunk: MeasuredToken[]) => chunk.reduce((sum, token) => sum + token.width, 0)

/** 贪心断行：行首空白折叠；块超宽（超长 URL 等）按字素硬切兜底，绝不切断字素簇 */
export function wrapTokens(tokens: Token[], measure: (text: string) => number, maxWidth: number): string[] {
  const measured: MeasuredToken[] = tokens.map((token) => ({ ...token, width: measure(token.text) }))
  const chunks = mergeChunks(measured)
  const lines: string[] = []
  let current: MeasuredToken[] = []
  let currentWidth = 0

  const flush = () => {
    if (current.length) {
      lines.push(current.map((token) => token.text).join(''))
      current = []
      currentWidth = 0
    }
  }
  const appendChunk = (chunk: MeasuredToken[]) => {
    current.push(...chunk)
    currentWidth += chunkWidth(chunk)
  }

  for (const chunk of chunks) {
    if (chunk[0].space && !current.length) {
      continue
    }
    if (chunk[0].space) {
      if (currentWidth + chunkWidth(chunk) <= maxWidth) {
        appendChunk(chunk)
      } else {
        flush()
      }
      continue
    }
    const width = chunkWidth(chunk)
    if (currentWidth + width <= maxWidth) {
      appendChunk(chunk)
      continue
    }
    flush()
    if (width <= maxWidth) {
      current = [...chunk]
      currentWidth = width
      continue
    }
    // 原子块本身就超宽：展开到字素级再逐行填充
    const subTokens: MeasuredToken[] = []
    for (const token of chunk) {
      if (token.width > maxWidth && token.text.length > 1) {
        for (const grapheme of splitGraphemes(token.text)) {
          subTokens.push({ ...token, text: grapheme, width: measure(grapheme) })
        }
      } else {
        subTokens.push(token)
      }
    }
    let buffer: MeasuredToken[] = []
    let bufferWidth = 0
    for (const subToken of subTokens) {
      if (bufferWidth + subToken.width <= maxWidth || !buffer.length) {
        buffer.push(subToken)
        bufferWidth += subToken.width
      } else {
        lines.push(buffer.map((token) => token.text).join(''))
        buffer = [subToken]
        bufferWidth = subToken.width
      }
    }
    lines.push(buffer.map((token) => token.text).join(''))
  }
  flush()
  return lines.length ? lines : ['']
}

// ---------------------------------------------------------------- 字体与文本净化

/** WinAnsi（内置 Helvetica）可编码保守集合；之外的字符统一替换为 ?，确保 drawText 不抛错 */
const WINANSI_KEEP =
  /^[\n\x20-\x7E\u00A0-\u00FF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]+$/

export function sanitizeForStandardFont(text: string): string {
  return text.replace(/[^\n]/g, (char) => (WINANSI_KEEP.test(char) ? char : '?'))
}

const CUSTOM_FONT_CANDIDATES = [
  process.env.BIBI_EXPORT_PDF_FONT || '',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf',
  '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf',
].filter(Boolean)

type ResolvedFonts = { body: PdfFont; bold: PdfFont; cjk: boolean }

async function resolveFonts(pdfDoc: pdfLib.PDFDocument, injectedFont?: Uint8Array | null): Promise<ResolvedFonts> {
  pdfDoc.registerFontkit(fontkit)
  const candidates: Array<Uint8Array | null> = injectedFont ? [injectedFont] : []
  if (!injectedFont) {
    for (const path of CUSTOM_FONT_CANDIDATES) {
      try {
        if (fs.existsSync(path)) {
          candidates.push(new Uint8Array(fs.readFileSync(path)))
        }
      } catch {
        // 忽略不可读路径，继续下一个候选
      }
    }
  }
  for (const bytes of candidates) {
    if (!bytes) {
      continue
    }
    try {
      const font = await pdfDoc.embedFont(bytes, { subset: true })
      return { body: font, bold: font, cjk: true }
    } catch {
      // 字体文件损坏或不受支持时回落内置字体
    }
  }
  const [helvetica, helveticaBold] = await Promise.all([
    pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica),
    pdfDoc.embedFont(pdfLib.StandardFonts.HelveticaBold),
  ])
  return { body: helvetica, bold: helveticaBold, cjk: false }
}

// ---------------------------------------------------------------- 排版

type DrawItem =
  | { kind: 'text'; text: string; x: number; size: number; gray: number; bold: boolean; lineHeight: number }
  | { kind: 'quoteRule'; x: number; height: number }
  | { kind: 'divider' }

type LaidOutPage = { items: DrawItem[] }

/** 把 blocks 排版成若干页的绘制指令；分页只发生在行/块边界 */
export function layoutBlocks(
  blocks: ExportBlock[],
  fonts: ResolvedFonts,
  options: { contentWidth?: number; pageHeight?: number } = {},
): LaidOutPage[] {
  const contentWidth = options.contentWidth ?? CONTENT_WIDTH
  const usableHeight = (options.pageHeight ?? PAGE.height) - MARGIN.top - MARGIN.bottom
  const measure = (text: string) => fonts.body.widthOfTextAtSize(text, BODY_SIZE)

  const pages: LaidOutPage[] = [{ items: [] }]
  let y = 0

  const newPage = () => {
    pages.push({ items: [] })
    y = 0
  }
  const ensureSpace = (height: number) => {
    if (y + height > usableHeight) {
      newPage()
    }
  }

  for (const block of blocks) {
    const isHeading = block.type === 'heading'
    const style: TextStyle = { ...STYLES[block.type] }
    if (block.type === 'heading') {
      style.size = HEADING_SIZES[block.level]
      style.lineHeight = style.size * 1.4
      style.bold = true
    }

    let lines: string[] = []
    let rawText = ''
    if (block.type === 'heading') {
      rawText = block.text
    } else if (block.type === 'paragraph') {
      rawText = block.text
    } else if (block.type === 'bullet') {
      rawText = block.text
    } else if (block.type === 'quote') {
      rawText = block.text
    } else if (block.type === 'meta') {
      rawText = `${block.label}：${block.value}`
    }

    if (block.type !== 'divider') {
      const sanitized = fonts.cjk ? rawText : sanitizeForStandardFont(rawText)
      lines = wrapTokens(tokenize(sanitized), measure, contentWidth - style.indent)
    }

    const blockHeight = lines.length * style.lineHeight

    if (isHeading) {
      // 孤行控制：标题至少携带 2 行正文空间，否则换页
      if (y + style.spaceBefore + blockHeight + 2 * BODY_LINE_HEIGHT > usableHeight) {
        newPage()
      }
    } else if (block.type !== 'divider' && blockHeight <= 3 * style.lineHeight) {
      // 小块（≤3 行）整块保持，不跨页拆散
      ensureSpace(style.spaceBefore + blockHeight + style.spaceAfter)
    }

    y += style.spaceBefore
    if (block.type === 'divider') {
      ensureSpace(1)
      pages[pages.length - 1].items.push({ kind: 'divider' })
      y += 1
    }
    for (let index = 0; index < lines.length; index += 1) {
      if (y + style.lineHeight > usableHeight) {
        newPage()
      }
      const item: DrawItem = {
        kind: 'text',
        text: lines[index],
        x: MARGIN.left + style.indent + (block.type === 'bullet' && index > 0 ? 10 : 0),
        size: style.size,
        gray: style.gray,
        bold: style.bold && fonts.cjk === false,
        lineHeight: style.lineHeight,
      }
      pages[pages.length - 1].items.push(item)
      if (block.type === 'quote') {
        pages[pages.length - 1].items.push({
          kind: 'quoteRule',
          x: MARGIN.left + style.indent - 6,
          height: style.lineHeight,
        })
      }
      y += style.lineHeight
    }
    y += style.spaceAfter
  }

  return pages
}

// ---------------------------------------------------------------- 主入口

export async function renderPdf(spec: ExportSpec, options: { fontData?: Uint8Array | null } = {}): Promise<Uint8Array> {
  const pdfDoc = await pdfLib.PDFDocument.create()
  pdfDoc.setTitle(spec.title)
  pdfDoc.setProducer('BibiGPT export')
  const fonts = await resolveFonts(pdfDoc, options.fontData ?? null)

  const pages = layoutBlocks(specToBlocks(spec), fonts)
  const drawColor = (gray: number) => pdfLib.rgb(gray, gray, gray)

  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pdfDoc.addPage([PAGE.width, PAGE.height])
    let y = PAGE.height - MARGIN.top
    for (const item of pages[pageIndex].items) {
      if (item.kind === 'divider') {
        page.drawLine({
          start: { x: MARGIN.left, y },
          end: { x: PAGE.width - MARGIN.right, y },
          thickness: 0.7,
          color: drawColor(0.85),
        })
        continue
      }
      if (item.kind === 'quoteRule') {
        page.drawLine({
          start: { x: item.x, y: y - 2 },
          end: { x: item.x, y: y + item.height - 4 },
          thickness: 2,
          color: drawColor(0.75),
        })
        continue
      }
      page.drawText(item.text, {
        x: item.x,
        y: y - item.size,
        size: item.size,
        font: item.bold ? fonts.bold : fonts.body,
        color: drawColor(item.gray),
      })
      y += item.lineHeight
    }
    // 页脚页码
    const label = `${pageIndex + 1} / ${pages.length}`
    page.drawText(label, {
      x: PAGE.width / 2 - fonts.body.widthOfTextAtSize(label, 8.5) / 2,
      y: MARGIN.bottom / 2,
      size: 8.5,
      font: fonts.body,
      color: drawColor(0.55),
    })
  }

  return pdfDoc.save()
}
