// SourceAdapter 契约 fixture：node --import ./lib/sources/__fixtures__/register.mjs ./lib/sources/__fixtures__/run.mjs
// BIBI_SMOKE=1 时追加真实 URL 冒烟（需外网；BIBI_SMOKE_STRICT=1 时失败计为不通过）
import { readFileSync } from 'node:fs'

import { bilibiliAdapter } from '../adapters/bilibili.ts'
import {
  createYoutubeAdapter,
  parseYoutubeVideoId,
  pickYoutubeSubtitleFormat,
  youtubeAdapter,
} from '../adapters/youtube.ts'
import { findSourceAdapter, parseVideoSourceUrl } from '../registry.ts'
import { parseSourceRef, sourceRefToUrl } from '../sourceRef.ts'
import { transcriptToPlainTextItems, transcriptToSubtitleItems } from '../toSubtitleItems.ts'
import { SourceError, sourceErrorCodeToHttpStatus } from '../types.ts'

const dataDir = new URL('./data/', import.meta.url)
const loadJson = (name) => JSON.parse(readFileSync(new URL(name, dataDir), 'utf8'))
const realFetch = globalThis.fetch.bind(globalThis)

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

async function expectSourceError(promise, code, label) {
  try {
    await promise
    assert(false, label, 'expected SourceError but resolved')
  } catch (error) {
    assert(
      error instanceof SourceError && error.code === code,
      label,
      `got ${error?.constructor?.name} ${error?.code}: ${error?.message}`,
    )
  }
}

function installMockFetch(routes) {
  const originalFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    seen.push(url)
    for (const route of routes) {
      if (route.match(url)) {
        const body = typeof route.body === 'function' ? route.body(url) : JSON.stringify(route.body)
        return new Response(body, { status: route.status ?? 200, headers: { 'content-type': 'application/json' } })
      }
    }
    return new Response(`mock 404 for ${url}`, { status: 404 })
  }
  return { restore: () => (globalThis.fetch = originalFetch), seen }
}

async function main() {
  delete process.env.BILIBILI_SESSION_TOKEN
  delete process.env.SAVESUBS_X_AUTH_TOKEN

  const extractMulti = loadJson('savesubs-extract-multi-lang.json')
  const extractAuto = loadJson('savesubs-extract-auto-only.json')
  const extractEmpty = loadJson('savesubs-extract-empty.json')
  const ytTranscript = loadJson('savesubs-transcript.json')
  const viewMultiPage = loadJson('bilibili-view-multipage.json')
  const playerSubs = loadJson('bilibili-player-subtitles.json')
  const biliBody = loadJson('bilibili-subtitle-body.json')

  // ---------- registry：白名单 ----------
  assert(findSourceAdapter('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.id === 'youtube', 'registry: youtube watch')
  assert(findSourceAdapter('https://youtu.be/dQw4w9WgXcQ')?.id === 'youtube', 'registry: youtu.be')
  assert(
    findSourceAdapter('https://music.youtube.com/watch?v=dQw4w9WgXcQ')?.id === 'youtube',
    'registry: music.youtube',
  )
  assert(
    findSourceAdapter('https://www.bilibili.com/video/BV1GJ411x7h7')?.id === 'bilibili',
    'registry: bilibili video',
  )
  assert(
    findSourceAdapter('https://m.bilibili.com/video/BV1GJ411x7h7?p=6')?.id === 'bilibili',
    'registry: m.bilibili p=6',
  )
  assert(findSourceAdapter('https://evil.com/?u=youtube.com/watch?v=x') === undefined, 'registry: 拒绝伪装参数域名')
  assert(findSourceAdapter('http://169.254.169.254/latest/meta-data/') === undefined, 'registry: 拒绝云元数据 SSRF')
  assert(findSourceAdapter('file:///etc/passwd') === undefined, 'registry: 拒绝 file 协议')
  assert(findSourceAdapter('javascript:alert(1)') === undefined, 'registry: 拒绝 javascript 协议')
  assert(findSourceAdapter('随便一段文字') === undefined, 'registry: 拒绝非 URL')
  assert(
    findSourceAdapter('https://www.bilibili.com/read/cv123456') === undefined,
    'registry: 拒绝 bilibili 非视频路径',
  )

  const parsedYt = parseVideoSourceUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1s')
  assert(parsedYt?.videoId === 'dQw4w9WgXcQ' && parsedYt?.adapter.id === 'youtube', 'parse: youtube watch 带 t 参数')
  assert(parseVideoSourceUrl('https://youtu.be/abc123XYZ_4')?.videoId === 'abc123XYZ_4', 'parse: youtu.be')
  assert(parseVideoSourceUrl('https://www.youtube.com/shorts/abcd1234EFG')?.videoId === 'abcd1234EFG', 'parse: shorts')
  assert(parseVideoSourceUrl('https://www.youtube.com/watch') === undefined, 'parse: 无 v 参数返回 undefined')
  const parsedBili = parseVideoSourceUrl('https://www.bilibili.com/video/BV1GJ411x7h7/?p=6')
  assert(parsedBili?.videoId === 'BV1GJ411x7h7' && parsedBili?.pageNumber === '6', 'parse: bilibili 分 P p=6')
  assert(parseVideoSourceUrl('https://www.bilibili.com/video/av352747000')?.videoId === 'av352747000', 'parse: av 号')

  // ---------- youtube：多语言选择 ----------
  {
    const mock = installMockFetch([
      { match: (u) => u.startsWith('https://savesubs.com/action/extract/9-9-9/zh'), body: ytTranscript },
      {
        match: (u) => u.startsWith('https://savesubs.com/action/extract'),
        method: 'POST',
        body: extractMulti,
      },
    ])
    const doc = await youtubeAdapter.fetch('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    assert(doc.service === 'youtube', 'youtube: service')
    assert(doc.title === 'Microsoft vs Google: AI War Explained | tech', 'youtube: title')
    assert(doc.duration === 795, 'youtube: duration 秒')
    assert(doc.language === 'zh-CN', 'youtube: 优先选 zh-CN 字幕')
    assert(doc.transcript.length === 10, 'youtube: transcript 段数')
    assert(doc.transcript[0].start === 0.48 && doc.transcript[0].end === 2.16, 'youtube: 首段 start/end')
    assert(doc.transcript[0].text === 'hello world', 'youtube: lines 以空格拼接')
    assert(doc.transcript[0].lang === 'zh-CN', 'youtube: segment lang')
    assert(
      doc.transcript[0].sourceRef?.startsWith('https://savesubs.com/action/extract/9-9-9/zh'),
      'youtube: 首段携带 provider 记录',
    )
    assert(
      doc.images?.[0]?.url === 'https://i.ytimg.com/vi/BdHaeczStRA/mqdefault.jpg',
      'youtube: thumbnail 补 https 前缀',
    )
    assert(doc.sourceRef === 'youtube:video:dQw4w9WgXcQ', 'youtube: sourceRef')
    assert(
      sourceRefToUrl(doc.sourceRef) === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'youtube: sourceRef 回指原 URL',
    )
    const extractCalls = mock.seen.filter((u) => u.endsWith('/action/extract'))
    assert(extractCalls.length === 1, 'youtube: extract 只请求一次', `got ${extractCalls.length}`)
    mock.restore()
  }

  // ---------- youtube：无 zh-CN 时回退 auto ----------
  {
    installMockFetch([
      { match: (u) => u.includes('/action/extract/1-1-1/auto'), body: ytTranscript },
      { match: (u) => u.startsWith('https://savesubs.com/action/extract'), body: extractAuto },
    ])
    const doc = await youtubeAdapter.fetch('https://youtu.be/autoOnly123')
    assert(doc.language === 'en' && doc.transcript[0].lang === 'en', 'youtube: auto 字幕归一为 en')
    assert(doc.title === 'Auto captions only' && doc.duration === 42, 'youtube: auto 元数据')
    globalThis.fetch = realFetch
  }

  // ---------- youtube：无字幕 / 外部失败 ----------
  {
    installMockFetch([{ match: (u) => u.startsWith('https://savesubs.com/action/extract'), body: extractEmpty }])
    await expectSourceError(
      youtubeAdapter.fetch('https://www.youtube.com/watch?v=noCap111'),
      'NO_TRANSCRIPT',
      'youtube: 无字幕',
    )
    globalThis.fetch = realFetch
  }
  {
    // savesubs 200 + BLOCKED（无有效 token）
    const extractBlocked = loadJson('savesubs-extract-blocked.json')
    installMockFetch([{ match: (u) => u.startsWith('https://savesubs.com/action/extract'), body: extractBlocked }])
    await expectSourceError(
      youtubeAdapter.fetch('https://www.youtube.com/watch?v=blocked1AA'),
      'AUTH_REQUIRED',
      'youtube: savesubs BLOCKED',
    )
    globalThis.fetch = realFetch
  }
  {
    installMockFetch([{ match: () => true, body: 'boom', status: 500 }])
    await expectSourceError(
      youtubeAdapter.fetch('https://www.youtube.com/watch?v=err500AAA'),
      'SOURCE_UNAVAILABLE',
      'youtube: provider 500',
    )
    globalThis.fetch = realFetch
  }
  {
    installMockFetch([{ match: () => true, body: 'slow down', status: 429 }])
    await expectSourceError(
      youtubeAdapter.fetch('https://www.youtube.com/watch?v=rate111AAA'),
      'RATE_LIMITED',
      'youtube: provider 429',
    )
    globalThis.fetch = realFetch
  }
  {
    // extract 成功但字幕内容解析失败
    installMockFetch([
      { match: (u) => u.includes('/action/extract/9-9-9/'), body: () => 'not-json{' },
      { match: (u) => u.startsWith('https://savesubs.com/action/extract'), body: extractMulti },
    ])
    await expectSourceError(
      youtubeAdapter.fetch('https://www.youtube.com/watch?v=badBodyAA'),
      'SOURCE_UNAVAILABLE',
      'youtube: 字幕内容无法解析',
    )
    globalThis.fetch = realFetch
  }
  {
    // 无法解析 videoId 的 URL
    await expectSourceError(
      youtubeAdapter.fetch('https://www.youtube.com/about'),
      'SOURCE_UNAVAILABLE',
      'youtube: 无法解析 videoId',
    )
  }

  // ---------- youtube：provider fallback 接口 ----------
  {
    let failedProviderCalled = false
    const failing = {
      id: 'mock-failing',
      async fetchTranscript() {
        failedProviderCalled = true
        throw new SourceError('RATE_LIMITED', 'mock provider 限流')
      },
    }
    const working = {
      id: 'mock-working',
      async fetchTranscript() {
        return { transcript: [{ start: 0, end: 1, text: 'from fallback' }], language: 'en' }
      },
    }
    const adapter = createYoutubeAdapter([failing, working])
    const doc = await adapter.fetch('https://www.youtube.com/watch?v=fallbackAA1')
    assert(failedProviderCalled, 'youtube fallback: 第一个 provider 被尝试')
    assert(doc.transcript[0].text === 'from fallback', 'youtube fallback: 回退到第二个 provider')
    // 全部 provider 失败时抛第一个 SourceError
    const allFail = createYoutubeAdapter([failing])
    await expectSourceError(
      allFail.fetch('https://www.youtube.com/watch?v=fallbackAA1'),
      'RATE_LIMITED',
      'youtube fallback: 全部失败抛 SourceError',
    )
  }

  // ---------- bilibili：分 P ----------
  {
    const mock = installMockFetch([
      { match: (u) => u.includes('/x/player/v2'), body: playerSubs },
      { match: (u) => u.includes('/x/web-interface/view'), body: viewMultiPage },
      { match: (u) => u.includes('aisubtitle.hdslb.com'), body: biliBody },
    ])
    const doc = await bilibiliAdapter.fetch('https://www.bilibili.com/video/BV1GJ411x7h7?p=2')
    assert(doc.service === 'bilibili' && doc.title === '测试用多分P视频', 'bilibili: service/title')
    assert(doc.duration === 100, 'bilibili: duration')
    assert(doc.transcript.length === 10, 'bilibili: transcript 段数')
    assert(
      doc.transcript[0].start === 0 && doc.transcript[0].end === 2 && doc.transcript[0].text === '大家好',
      'bilibili: 段内容',
    )
    assert(doc.language === 'ai-zh', 'bilibili: language 为所选字幕 lan')
    assert(doc.sourceRef === 'bilibili:video:BV1GJ411x7h7:p2', 'bilibili: 分 P sourceRef')
    assert(
      sourceRefToUrl(doc.sourceRef) === 'https://www.bilibili.com/video/BV1GJ411x7h7?p=2',
      'bilibili: sourceRef 回指原 URL',
    )
    assert(parseSourceRef(doc.sourceRef)?.pageNumber === 2, 'bilibili: parseSourceRef 带 pageNumber')
    assert(doc.chapters?.length === 2, 'bilibili: 分 P 映射 chapters')
    assert(doc.chapters?.[0]?.start === 0 && doc.chapters?.[1]?.start === 30, 'bilibili: chapters 累计起始秒')
    assert(doc.chapters?.[1]?.title === '第二P' && doc.chapters?.[1]?.end === 100, 'bilibili: chapter 标题与结束秒')
    assert(
      doc.transcript[0].sourceRef === 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/mock.json',
      'bilibili: 首段携带 provider 记录',
    )
    const playerCall = mock.seen.find((u) => u.includes('/x/player/v2'))
    assert(playerCall?.includes('cid=1035524242'), 'bilibili: p=2 选中第二分 P 的 cid', `got ${playerCall}`)
    mock.restore()
  }

  // ---------- bilibili：默认 P1 与 zh-CN 优先 ----------
  {
    const withZh = {
      ...playerSubs,
      data: {
        subtitle: {
          subtitles: [
            { lan: 'en', subtitle_url: '//x/en.json' },
            { lan: 'zh-CN', subtitle_url: '//x/zh.json' },
          ],
        },
      },
    }
    installMockFetch([
      { match: (u) => u.includes('/x/player/v2'), body: withZh },
      { match: (u) => u.includes('/x/web-interface/view'), body: viewMultiPage },
      { match: (u) => u.endsWith('/x/zh.json'), body: biliBody },
    ])
    const doc = await bilibiliAdapter.fetch('https://www.bilibili.com/video/BV1GJ411x7h7')
    assert(doc.language === 'zh-CN' && doc.transcript[0].lang === 'zh-CN', 'bilibili: zh-CN 优先于其它语言')
    assert(doc.sourceRef === 'bilibili:video:BV1GJ411x7h7', 'bilibili: p1 不带后缀')
    globalThis.fetch = realFetch
  }

  // ---------- bilibili：无字幕降级 description / 全空 NO_TRANSCRIPT ----------
  {
    const noSub = { ...playerSubs, data: { subtitle: { subtitles: [] } } }
    installMockFetch([
      { match: (u) => u.includes('/x/player/v2'), body: noSub },
      { match: (u) => u.includes('/x/web-interface/view'), body: viewMultiPage },
    ])
    const doc = await bilibiliAdapter.fetch('https://www.bilibili.com/video/BV1GJ411x7h7')
    assert(
      doc.transcript.length === 0 && doc.descriptionText === '这是视频简介',
      'bilibili: 无字幕降级 descriptionText',
    )
    globalThis.fetch = realFetch

    const noDesc = { ...viewMultiPage, data: { ...viewMultiPage.data, desc: '', dynamic: '' } }
    installMockFetch([
      { match: (u) => u.includes('/x/player/v2'), body: noSub },
      { match: (u) => u.includes('/x/web-interface/view'), body: noDesc },
    ])
    await expectSourceError(
      bilibiliAdapter.fetch('https://www.bilibili.com/video/BV1GJ411x7h7'),
      'NO_TRANSCRIPT',
      'bilibili: 无字幕无简介 NO_TRANSCRIPT',
    )
    globalThis.fetch = realFetch
  }

  // ---------- bilibili：风控 / 不存在 / 分 P 越界 ----------
  {
    installMockFetch([
      { match: (u) => u.includes('/x/web-interface/view'), body: { code: -412, message: '请求被拦截' } },
    ])
    await expectSourceError(
      bilibiliAdapter.fetch('https://www.bilibili.com/video/BV1blocked99'),
      'AUTH_REQUIRED',
      'bilibili: -412 风控/验证码',
    )
    globalThis.fetch = realFetch

    installMockFetch([{ match: (u) => u.includes('/x/web-interface/view'), body: { code: -404, message: '啥都木有' } }])
    await expectSourceError(
      bilibiliAdapter.fetch('https://www.bilibili.com/video/BV1notFound9'),
      'SOURCE_UNAVAILABLE',
      'bilibili: -404 不存在',
    )
    globalThis.fetch = realFetch

    installMockFetch([{ match: (u) => u.includes('/x/web-interface/view'), body: viewMultiPage }])
    await expectSourceError(
      bilibiliAdapter.fetch('https://www.bilibili.com/video/BV1GJ411x7h7?p=99'),
      'SOURCE_UNAVAILABLE',
      'bilibili: 分 P 越界',
    )
    globalThis.fetch = realFetch
  }

  // ---------- 旧链路映射：分组与时间戳前缀（与 reduceSubtitleTimestamp 对齐） ----------
  {
    const segments = biliBody.body.map((item, index, arr) => ({
      start: item.from,
      end: arr[index + 1]?.from ?? item.from,
      text: item.content,
    }))
    const grouped = transcriptToSubtitleItems(segments)
    assert(grouped.length === 2, 'mapper: 10 条按 7 分组')
    assert(grouped[0].index === 0 && grouped[1].index === 1, 'mapper: 组索引')
    assert(grouped[0].s === 0 && grouped[1].s === 16.6, 'mapper: s 取组首条 start')
    assert(grouped[0].text === '大家好 今天讲点啥 第三句 第四句 第五句 第六句 第七句 ', 'mapper: 无时间戳纯文本')
    const timestamped = transcriptToSubtitleItems(segments, true)
    assert(timestamped[1].text.startsWith('16.6 - '), 'mapper: 时间戳前缀')
    const plain = transcriptToPlainTextItems(segments)
    assert(plain.length === 10 && plain[3].text === '第四句' && plain[3].index === 3, 'mapper: 无时间戳逐段一项')
  }

  // ---------- 错误码到 HTTP 状态映射（buildSummarizeRequest 使用） ----------
  {
    assert(sourceErrorCodeToHttpStatus('NO_TRANSCRIPT') === 501, 'http: NO_TRANSCRIPT→501')
    assert(sourceErrorCodeToHttpStatus('AUTH_REQUIRED') === 403, 'http: AUTH_REQUIRED→403')
    assert(sourceErrorCodeToHttpStatus('SOURCE_UNAVAILABLE') === 502, 'http: SOURCE_UNAVAILABLE→502')
    assert(sourceErrorCodeToHttpStatus('RATE_LIMITED') === 429, 'http: RATE_LIMITED→429')
  }

  // ---------- 工具函数 ----------
  {
    const formats = extractMulti.response.formats
    assert(pickYoutubeSubtitleFormat(formats).quality === 'zh-CN', 'picker: zh-CN 最优')
    assert(pickYoutubeSubtitleFormat([formats[1]]).quality.startsWith('English (auto'), 'picker: 仅 auto 时选 auto')
    assert(parseYoutubeVideoId(new URL('https://www.youtube.com/live/abc123-45')) === 'abc123-45', 'parse: live 形态')
    assert(parseSourceRef('youtube:video:dQw4w9WgXcQ')?.service === 'youtube', 'parseSourceRef: youtube')
  }

  console.log(`\nfixtures: ${passed} passed, ${failed} failed`)
  if (failures.length) {
    console.log('failures:')
    for (const f of failures) {
      console.log(`  - ${f}`)
    }
  }

  if (process.env.BIBI_SMOKE === '1') {
    await realSmoke()
  }

  process.exitCode = failed > 0 ? 1 : 0
}

async function realSmoke() {
  console.log('\n--- 真实 URL 冒烟（BIBI_SMOKE=1）---')
  globalThis.fetch = realFetch
  // .env 简易加载（仅冒烟用）
  try {
    const envText = readFileSync(new URL('../../../../.env', import.meta.url), 'utf8')
    for (const line of envText.split('\n')) {
      const matched = line.match(/^([A-Z_0-9]+)=(.*)$/)
      if (matched && !process.env[matched[1]]) {
        process.env[matched[1]] = matched[2]
      }
    }
  } catch {
    // 无 .env 时跳过
  }

  const cases = [
    ['youtube', 'https://www.youtube.com/watch?v=jNQXAC9IVRw'],
    ['bilibili', 'https://www.bilibili.com/video/BV1GJ411x7h7'],
  ]
  let smokeFailed = 0
  for (const [label, url] of cases) {
    const adapter = findSourceAdapter(url)
    if (!adapter) {
      console.log(`[${label}] SKIP: 不支持该 URL`)
      continue
    }
    try {
      const doc = await adapter.fetch(url)
      console.log(
        `[${label}] OK: "${doc.title}" segments=${doc.transcript.length} lang=${doc.language ?? '-'} duration=${
          doc.duration ?? '-'
        } sourceRef=${doc.sourceRef}`,
      )
    } catch (error) {
      smokeFailed += 1
      console.log(
        `[${label}] ${error instanceof SourceError ? `SourceError ${error.code}` : 'ERROR'}: ${error.message}`,
      )
    }
  }
  if (process.env.BIBI_SMOKE_STRICT === '1' && smokeFailed > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('fixture runner crashed:', error)
  process.exitCode = 1
})
