// KIN-47 导出模块契约测试：node --import ./lib/export/__tests__/register.mjs ./lib/export/__tests__/run.mjs
// 覆盖：块模型时间戳分区、Markdown/JSON 渲染、字素级断行（不切 glyph/标点不落行首）、
// PDF 非空与长文分页、DOCX 非空、AES-GCM 加密往返与下载签名、provider 注册表与未实现错误。
import { readFileSync } from 'node:fs'
import * as pdfLib from 'pdf-lib'

import { formatTimestamp, specToBlocks } from '../blocks.ts'
import { renderMarkdown } from '../markdown.ts'
import { renderJson } from '../json.ts'
import { renderPdf, layoutBlocks, tokenize, wrapTokens, splitGraphemes, sanitizeForStandardFont } from '../pdf.ts'
import { renderDocx } from '../docx.ts'
import { renderExport, buildExportFilename } from '../render.ts'
import {
  encryptSecret,
  decryptSecret,
  signDownloadToken,
  verifyDownloadToken,
  parseDownloadToken,
  buildDownloadUrl,
} from '../crypto.ts'
import { ExportError } from '../errors.ts'
import { getProvider, listProviders } from '../providers/registry.ts'
import { buildFlomoContent, validateFlomoWebhook } from '../providers/flomo.ts'
import { validateLarkWebhook } from '../providers/larkWebhook.ts'
import { imaProvider } from '../providers/ima.ts'
import { emailProvider } from '../providers/email.ts'

let passed = 0
let failed = 0
const failures = []

function assert(condition, label, detail) {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  failures.push(detail ? `${label}: ${detail}` : label)
}

async function expectThrows(promiseOrFn, check, label) {
  try {
    const result = typeof promiseOrFn === 'function' ? await promiseOrFn() : await promiseOrFn
    assert(false, label, `expected throw, got ${result}`)
  } catch (error) {
    assert(check ? check(error) : true, label, error?.message)
  }
}

const KEY = 'k'.repeat(32)

// ExportSpec 契约 fixture（字段与 lib/export/types.ts 对齐）
const spec = {
  title: '测试视频：统一导出管线',
  sourceUrl: 'https://www.youtube.com/watch?v=abc123',
  service: 'youtube',
  sourceRef: 'youtube:video:abc123',
  duration: 3725,
  language: 'zh',
  summary: '第一段摘要。\n\n第二段摘要，包含重点内容与公式 E=mc²。',
  summaryMeta: { id: 'sum-1', model: 'gpt-test', version: 2, createdAt: '2026-09-27T00:00:00Z' },
  transcript: {
    id: 'tr-1',
    lang: 'zh',
    fullText: null,
    segments: [
      { idx: 0, start: 0, end: 5, text: '开场白', speaker: null },
      { idx: 1, start: 75, end: 80, text: '核心观点：导出不注入时间戳', speaker: 'kinso' },
    ],
  },
  transcriptMissingReason: null,
  chapters: [{ idx: 0, title: '开场', start: 0, end: 60, summary: '介绍', source: 'platform', segmentIds: [0] }],
  highlights: [{ idx: 0, text: '重点一', start: 61.5, end: 70, note: '很关键', segmentIds: [1] }],
  keywords: [{ term: '导出', segmentIds: [] }],
  outline: [{ level: 1, title: '大纲一', start: 0, end: null, segmentIds: [] }],
  speakers: [],
  backlinks: [],
  images: [{ url: 'https://example.com/a.jpg', alt: '封面' }],
  artifacts: [{ id: 'art-1', kind: 'chapters', version: 1, createdAt: '2026-09-27T00:00:00Z' }],
  generatedAt: '2026-09-27T00:00:00Z',
  exportedAt: '2026-09-27T01:00:00Z',
}

// ---------------------------------------------------------------- 时间戳与块模型

assert(formatTimestamp(0) === '00:00', 'formatTimestamp 0')
assert(formatTimestamp(75) === '01:15', 'formatTimestamp 75')
assert(formatTimestamp(3725) === '1:02:05', 'formatTimestamp 3725')
assert(formatTimestamp(null) === null, 'formatTimestamp null')

{
  const blocks = specToBlocks(spec)
  const summaryIndex = blocks.findIndex((b) => b.type === 'heading' && b.text === '摘要')
  const transcriptIndex = blocks.findIndex((b) => b.type === 'heading' && b.text === '原文字幕')
  assert(summaryIndex > 0 && transcriptIndex > summaryIndex, '块模型：摘要先于原文字幕')
  // 摘要区（polished article）不含任何时间戳
  const summaryTexts = blocks
    .slice(
      summaryIndex,
      blocks.findIndex((b) => b.type === 'heading' && b.text === '章节'),
    )
    .filter((b) => b.type === 'paragraph')
    .map((b) => b.text)
  assert(
    summaryTexts.some((t) => t === '第一段摘要。'),
    '块模型：摘要段落保留',
  )
  assert(!summaryTexts.some((t) => /\[\d{1,2}:\d{2}/.test(t)), '块模型：摘要正文零时间戳')
  // 字幕区带时间戳与说话人
  const transcriptTexts = blocks
    .slice(transcriptIndex)
    .filter((b) => b.type === 'paragraph')
    .map((b) => b.text)
  assert(
    transcriptTexts.some((t) => t.startsWith('[00:00] ') && t.endsWith('开场白')),
    '块模型：字幕时间戳前缀',
  )
  assert(
    transcriptTexts.some((t) => t.includes('[01:15] kinso：核心观点')),
    '块模型：字幕说话人前缀',
  )
  // 章节带【mm:ss】
  const chapterBullet = blocks.find((b) => b.type === 'bullet' && b.text.includes('开场'))
  assert(chapterBullet && chapterBullet.text.startsWith('【00:00】'), '块模型：章节时间戳')
}

// ---------------------------------------------------------------- Markdown / JSON

{
  const md = renderMarkdown(spec)
  assert(md.startsWith('# 测试视频：统一导出管线'), 'markdown：一级标题')
  assert(md.includes('## 摘要'), 'markdown：摘要节')
  assert(md.includes('- **来源**: https://www.youtube.com/watch?v=abc123'), 'markdown：meta 行')
  assert(md.includes('> [01:01] 重点一'), 'markdown：重点引用')
  assert(md.includes('批注：很关键'), 'markdown：重点批注')
  assert(md.includes('## 原文字幕'), 'markdown：原文分区')
  assert(md.includes('[00:00] 开场白'), 'markdown：字幕行')
  const summarySection = md.split('## 摘要')[1].split('## 章节')[0]
  assert(!/\[\d{1,2}:\d{2}/.test(summarySection), 'markdown：摘要节零时间戳')
}
{
  const parsed = JSON.parse(renderJson(spec))
  assert(parsed.title === spec.title, 'json：title')
  assert(Array.isArray(parsed.speakers) && parsed.speakers.length === 0, 'json：speakers 保留字段为空数组')
  assert(Array.isArray(parsed.backlinks) && parsed.backlinks.length === 0, 'json：backlinks 保留字段为空数组')
  assert(parsed.transcript.segments.length === 2, 'json：transcript segments')
  assert(parsed.chapters[0].source === 'platform', 'json：chapters 契约字段')
}

// ---------------------------------------------------------------- 字素级断行

{
  const measure = (text) => text.length
  const joinLike = (lines) => lines.join('')
  // CJK 逐字可断
  {
    const text = '统一导出管线分页测试'.repeat(30)
    const lines = wrapTokens(tokenize(text), measure, 37)
    assert(
      lines.every((line) => line.length <= 37),
      'wrap：每行不超宽',
    )
    assert(joinLike(lines) === text, 'wrap：CJK 无损重组')
  }
  // 西文单词不可断
  {
    const lines = wrapTokens(tokenize('hello world foo'), measure, 5)
    assert(JSON.stringify(lines) === JSON.stringify(['hello', 'world', 'foo']), 'wrap：西文按词断行')
  }
  // 闭合标点不落行首（粘连锁块可容纳时）
  {
    const text = 'aaaaaaaa，bbbb'
    const lines = wrapTokens(tokenize(text), measure, 10)
    assert(joinLike(lines) === text, 'wrap：标点场景无损重组')
    assert(!lines.some((line) => line.startsWith('，')), 'wrap：闭合标点不落行首')
  }
  // emoji（ZWJ 序列）不被切断
  {
    const family = '👨‍👩‍👧'
    assert(splitGraphemes(`${family}x`).length === 2, 'grapheme：ZWJ 序列为单簇')
    const text = `ab${family}cd${family}ef`
    const lines = wrapTokens(tokenize(text), measure, 4)
    assert(joinLike(lines) === text, 'wrap：emoji 场景无损重组')
    assert(
      lines.every((line) => splitGraphemes(line).every((cluster) => cluster === family || cluster.length === 1)),
      'wrap：emoji 整簇落行',
    )
  }
  // 超长 URL 硬切兜底
  {
    const url = `https://example.com/${'x'.repeat(50)}`
    const lines = wrapTokens(tokenize(url), measure, 10)
    assert(lines.length > 1 && joinLike(lines) === url, 'wrap：超长 URL 硬切且无损')
  }
  assert(sanitizeForStandardFont('中文abc—') === '??abc—', 'sanitize：WinAnsi 保守净化')
}

// ---------------------------------------------------------------- 排版分页

{
  const fakeFont = { widthOfTextAtSize: (text, size) => text.length * size * 0.55 }
  const fonts = { body: fakeFont, bold: fakeFont, cjk: true }
  // 短文档单页
  {
    const pages = layoutBlocks(specToBlocks(spec), fonts)
    assert(pages.length === 1, 'layout：短文档单页')
  }
  // 长文档多页 + 每行/缩进边界合法
  {
    const longSpec = {
      ...spec,
      summary: Array.from({ length: 120 }, (_, i) => `第${i}段：这是用于测试长文本分页稳定性的中文内容。`).join('\n\n'),
      transcript: null,
      transcriptMissingReason: '该视频没有可用字幕',
    }
    const pages = layoutBlocks(specToBlocks(longSpec), fonts)
    assert(pages.length > 1, 'layout：长文档多页分页')
    assert(
      pages.every((page) =>
        page.items.every((item) => item.kind !== 'text' || (item.x >= 56 && item.x <= 595.28 - 56 + 0.01)),
      ),
      'layout：所有行在页宽内',
    )
    // 标题孤行控制：任何页最后一个元素都不是大标题
    const lastItems = pages.slice(0, -1).map((page) => page.items[page.items.length - 1])
    assert(
      lastItems.every((item) => item.kind !== 'text' || item.size < 14),
      'layout：标题不落页尾孤行',
    )
  }
}

// ---------------------------------------------------------------- PDF / DOCX 产物

{
  const longSpec = {
    ...spec,
    summary: Array.from({ length: 200 }, (_, i) => `第${i}段：PDF 长文分页应稳定且不切断段落。`).join('\n\n'),
  }
  const bytes = await renderPdf(longSpec)
  assert(bytes.length > 3000, 'pdf：产物非空', `size=${bytes.length}`)
  assert(String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-', 'pdf：%PDF magic')
  const doc = await pdfLib.PDFDocument.load(bytes)
  assert(doc.getPageCount() >= 2, 'pdf：长文分页 ≥2 页', `pages=${doc.getPageCount()}`)
}
{
  const buffer = await renderDocx(spec)
  assert(buffer.length > 1000, 'docx：产物非空', `size=${buffer.length}`)
  assert(buffer[0] === 0x50 && buffer[1] === 0x4b, 'docx：PK zip magic')
}
{
  const rendered = await renderExport(spec, 'markdown')
  assert(rendered.mime.startsWith('text/markdown'), 'render：markdown mime')
  assert(buildExportFilename(spec, 'pdf').endsWith('.pdf'), 'render：pdf 文件名后缀')
  assert(!/[\\/:*?"<>|]/.test(buildExportFilename({ ...spec, title: 'a:b/c*d' }, 'md')), 'render：文件名净化')
}

// ---------------------------------------------------------------- 加密与签名

{
  const secret = 'https://flomoapp.com/iwh/M000000y/d8d123456'
  const blob = encryptSecret(secret, KEY)
  assert(blob.startsWith('enc:v1:'), 'crypto：密文前缀')
  assert(!blob.includes(secret), 'crypto：密文不含明文')
  assert(decryptSecret(blob, KEY) === secret, 'crypto：解密往返')
  assert(encryptSecret(secret, KEY) !== blob, 'crypto：随机 IV 两次密文不同')
  await expectThrows(() => decryptSecret(blob, 'x'.repeat(32)), null, 'crypto：错误密钥解密失败')
  await expectThrows(
    () => encryptSecret('x', undefined),
    (error) => error instanceof ExportError && error.code === 'export_secret_missing',
    'crypto：缺 EXPORT_SECRET_KEY 结构化报错',
  )
  // 下载 token
  const payload = { contentId: 'c-1', format: 'pdf', userId: 'u-1', exp: Date.now() + 60000 }
  const signature = signDownloadToken(payload, KEY)
  assert(verifyDownloadToken(payload, signature, KEY), 'crypto：签名校验通过')
  assert(!verifyDownloadToken({ ...payload, format: 'docx' }, signature, KEY), 'crypto：篡改 payload 拒绝')
  assert(!verifyDownloadToken({ ...payload, exp: Date.now() - 1 }, signature, KEY), 'crypto：过期 token 拒绝')
  const url = buildDownloadUrl('/api/export/download', payload, KEY)
  const parsed = parseDownloadToken(Object.fromEntries(new URL(`https://x.com${url}`).searchParams))
  assert(
    parsed && parsed.payload.contentId === 'c-1' && verifyDownloadToken(parsed.payload, parsed.signature, KEY),
    'crypto：URL 解析往返',
  )
}

// ---------------------------------------------------------------- providers

{
  assert(listProviders().length === 6, 'registry：六个 provider')
  assert(getProvider('flomo')?.id === 'flomo' && getProvider('nope') === null, 'registry：查找与兜底')
  await expectThrows(
    () => imaProvider.deliver(spec, { config: {}, secret: null }),
    (error) => error instanceof ExportError && error.code === 'not_implemented',
    'provider：IMA 未实现结构化错误',
  )
  await expectThrows(
    () => emailProvider.deliver(spec, { config: {}, secret: null }),
    (error) => error instanceof ExportError && error.code === 'not_implemented',
    'provider：Email 未实现结构化错误',
  )
  assert(
    validateFlomoWebhook('https://flomoapp.com/iwh/M000/d8d') === 'https://flomoapp.com/iwh/M000/d8d',
    'flomo：合法 webhook',
  )
  await expectThrows(
    () => validateFlomoWebhook('http://flomoapp.com/iwh/x'),
    (error) => error.code === 'invalid_webhook',
    'flomo：拒绝 http',
  )
  await expectThrows(
    () => validateFlomoWebhook('https://evil.com/iwh/x'),
    (error) => error.code === 'invalid_webhook',
    'flomo：拒绝异域（防 SSRF）',
  )
  await expectThrows(
    () => validateLarkWebhook('https://evil.com/open-apis/bot/v2/hook/x'),
    (error) => error.code === 'invalid_webhook',
    'lark：拒绝异域（防 SSRF）',
  )
  const content = buildFlomoContent(spec)
  assert(
    content.includes(spec.title) && content.includes(spec.sourceUrl) && content.includes('#BibiGPT'),
    'flomo：内容结构',
  )
  // 错误消息脱敏
  const leak = new ExportError('provider_failed', 502, 'token sk-abcdef123456 leaked')
  assert(!leak.message.includes('sk-abcdef123456'), 'errors：redactSecrets 生效')
}

// ---------------------------------------------------------------- 汇总

console.log(`\npassed=${passed} failed=${failed}`)
if (failures.length) {
  console.log('--- failures ---')
  for (const failure of failures) {
    console.log(`  ✗ ${failure}`)
  }
  process.exit(1)
}
