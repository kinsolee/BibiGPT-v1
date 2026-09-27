// KIN-46 新来源 fixture：node --import ../../__fixtures__/register.mjs --import ./register-kin46.mjs ./lib/sources/adapters/__fixtures__/run-kin46.mjs
// 覆盖：字幕解析 / 本地存储断点续传 / fileId 绑定 / ASR(真实 HTTP mock) / 超长音频分段 /
//       podcast RSS / 无字幕 YouTube ASR / 抖音快手小红书微信骨架 / ingest transcript+summary
// 媒体 fixture 由本机 ffmpeg + say 现场生成（缺失时对应块 SKIP）。
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

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
  console.log(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
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

// ---------- env（必须在调用任何 lib 函数前就绪） ----------
const workRoot = mkdtempSync(path.join(tmpdir(), 'bibi-kin46-fixtures-'))
const uploadDir = path.join(workRoot, 'uploads')
const mediaDir = path.join(workRoot, 'media')
for (const dir of [uploadDir, mediaDir]) {
  await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }))
}
process.env.BIBI_UPLOAD_DIR = uploadDir
process.env.BIBI_ASR_API_KEY = 'sk-test-asr-key-0000000000'
delete process.env.BIBI_ASR_LANGUAGE
delete process.env.BIBI_DOUYIN_COOKIE
delete process.env.BIBI_KUAISHOU_COOKIE
delete process.env.BIBI_XHS_COOKIE
delete process.env.BIBI_WECHAT_COOKIE
delete process.env.BIBI_JOB_ASYNC_RETURN

// ---------- 被测模块 ----------
const { parseSrt, parseVtt, parseAss, parseSubtitleFile, parseSubtitleTimestamp } = await import(
  '../subtitleParsers.ts'
)
const { douyinAdapter, parseDouyinSource } = await import('../douyin.ts')
const { kuaishouAdapter, parseKuaishouSource } = await import('../kuaishou.ts')
const { xiaohongshuAdapter, parseXiaohongshuSource } = await import('../xiaohongshu.ts')
const { parseWechatSource, wechatAdapter } = await import('../wechat.ts')
const { localFileAdapter, parseLocalFileId } = await import('../localFile.ts')
const { podcastAdapter } = await import('../podcast.ts')
const { youtubeAsrAdapter, youtubeAsrProvider } = await import('../youtubeAsr.ts')
const { runIngest } = await import('../ingest.ts')
const { findExtendedSourceAdapter } = await import('../extendedRegistry.ts')
const { findSourceAdapter } = await import('../../registry.ts')
const { SourceError } = await import('../../types.ts')
const {
  UploadStoreError,
  appendChunk,
  buildLocalFileUrl,
  completeUpload,
  getSessionReceivedBytes,
  initUpload,
  isValidFileId,
  resolveCompletedUpload,
} = await import('~/lib/storage/localStore.ts')
const { sniffContainer } = await import('~/lib/storage/mediaProbe.ts')
const { transcribeAudioFile, resolveAsrConfig } = await import('~/lib/asr/whisper.ts')

// ---------- mock 服务器工具 ----------
function listenRandom(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

function createWhisperMock() {
  let handler = async () => ({ status: 200, payload: { text: '' } })
  const calls = []
  const server = createHttpServer(async (req, res) => {
    const body = await readRequestBody(req)
    const bodyText = body.toString('utf8')
    calls.push({
      url: req.url,
      contentType: req.headers['content-type'] || '',
      hasFilePart: bodyText.includes('name="file"'),
      hasModelPart: bodyText.includes('name="model"'),
      hasVerboseFormat: bodyText.includes('verbose_json'),
      bodyBytes: body.length,
    })
    const result = await handler(body)
    res.writeHead(result.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result.payload))
  })
  return {
    server,
    calls,
    setHandler(next) {
      handler = next
    },
    resetCalls() {
      calls.length = 0
    },
  }
}

// ---------- 媒体 fixture 生成 ----------
function hasBin(bin) {
  try {
    execFileSync('which', [bin], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

const hasFfmpeg = hasBin('ffmpeg')
const hasFfprobe = hasBin('ffprobe')
const hasSay = process.platform === 'darwin' && hasBin('say')

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe', timeout: 300_000 })
}

const voiceAiff = hasSay && hasFfmpeg ? path.join(mediaDir, 'voice.aiff') : null
if (voiceAiff) {
  execFileSync('say', ['-o', voiceAiff, 'BibiGPT local file pipeline test. Hello from the fixture runner.'], {
    stdio: 'pipe',
    timeout: 60_000,
  })
}

const fixtures = { bigMp3: null, voiceMp3: null }
if (hasFfmpeg) {
  if (voiceAiff) {
    fixtures.voiceMp3 = path.join(mediaDir, 'voice.mp3')
    ffmpeg(['-i', voiceAiff, '-codec:a', 'libmp3lame', '-b:a', '64k', fixtures.voiceMp3])
  }
  // 超过单请求上限（24MB）的真音频：静音 mp3 64k 约 3200 秒 ≈ 25MB
  const bigMp3 = path.join(mediaDir, 'big.mp3')
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=16000:cl=mono',
    '-t',
    '3260',
    '-codec:a',
    'libmp3lame',
    '-b:a',
    '64k',
    bigMp3,
  ])
  fixtures.bigMp3 = bigMp3
}

// ---------- 1. 字幕解析 ----------
{
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:03,500',
    'Hello world',
    '',
    '2',
    '00:00:03,500 --> 00:00:06,000',
    'Second cue',
    'continues here',
    '',
  ].join('\n')
  const segments = parseSrt(srt)
  assert(segments.length === 2, 'srt: 两条 cue')
  assert(segments[0].start === 1 && segments[0].end === 3.5 && segments[0].text === 'Hello world', 'srt: 时间与文本')
  assert(segments[1].text === 'Second cue continues here', 'srt: 多行文本合并')

  const vtt = ['WEBVTT', '', 'intro', '00:00.000 --> 00:02.000 position:50% align:left', 'Vtt cue', ''].join('\n')
  const vttSegments = parseVtt(vtt)
  assert(vttSegments.length === 1, 'vtt: 一条 cue')
  assert(vttSegments[0].start === 0 && vttSegments[0].end === 2, 'vtt: cue 设置不污染时间')
  assert(vttSegments[0].text === 'Vtt cue', 'vtt: 文本')

  const ass = [
    '[Script Info]',
    'Title: test',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.50,0:00:04.00,Default,,0,0,0,,{\\i1}Ass cue{\\i0}\\Nsecond line',
    'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,带,逗号的文本',
    '',
  ].join('\n')
  const assSegments = parseAss(ass)
  assert(assSegments.length === 2, 'ass: 两条 Dialogue')
  assert(assSegments[0].start === 1.5 && assSegments[0].end === 4, 'ass: 厘秒时间戳')
  assert(assSegments[0].text === 'Ass cue second line', 'ass: 覆盖标签剥离与 \\N 合并', assSegments[0].text)
  assert(assSegments[1].text === '带,逗号的文本', 'ass: Text 字段保留逗号', assSegments[1].text)

  assert(parseSubtitleTimestamp('1:02.5') === 62.5, 'timestamp: 分:秒.厘')
  assert(parseSubtitleTimestamp('00:01:02,500') === 62.5, 'timestamp: 时:分:秒,毫')
  await expectSourceError(
    Promise.resolve().then(() => parseSubtitleFile('x.txt', 'nope')),
    'SOURCE_UNAVAILABLE',
    'subtitle: 未知扩展名',
  )
  await expectSourceError(
    Promise.resolve().then(() => parseSubtitleFile('empty.srt', '')),
    'NO_TRANSCRIPT',
    'subtitle: 空文件',
  )
}

// ---------- 2. registry 白名单 ----------
console.log(`[section] registry`)
{
  assert(
    findExtendedSourceAdapter('https://www.douyin.com/video/7301234567890123456')?.id === 'douyin',
    'registry-x: douyin video',
  )
  assert(
    findExtendedSourceAdapter('https://v.douyin.com/iabc123/') === undefined,
    'registry-x: douyin 短链不在白名单（无 ID 形态）',
  )
  assert(
    findExtendedSourceAdapter('https://www.kuaishou.com/short-video/3xabc')?.id === 'kuaishou',
    'registry-x: kuaishou',
  )
  assert(
    findExtendedSourceAdapter('https://www.xiaohongshu.com/explore/abc123')?.id === 'xiaohongshu',
    'registry-x: xhs explore',
  )
  assert(findExtendedSourceAdapter('https://xhslink.com/abcXYZ')?.id === 'xiaohongshu', 'registry-x: xhs 短链')
  assert(
    findExtendedSourceAdapter('https://mp.weixin.qq.com/s/abcDEF123')?.id === 'wechat',
    'registry-x: wechat article',
  )
  assert(
    findExtendedSourceAdapter('https://channels.weixin.qq.com/profile/abc')?.id === 'wechat',
    'registry-x: wechat channels',
  )
  assert(
    findSourceAdapter('https://www.douyin.com/video/7301234567890123456') === undefined,
    'registry-legacy: douyin 不进旧白名单',
  )
  assert(
    findSourceAdapter('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.id === 'youtube',
    'registry-legacy: youtube 不变',
  )
  assert(
    findSourceAdapter('https://www.bilibili.com/video/BV1GJ411x7h7')?.id === 'bilibili',
    'registry-legacy: bilibili 不变',
  )
  assert(findExtendedSourceAdapter('file:///etc/passwd') === undefined, 'registry-x: 拒绝 file 协议')
  assert(
    findExtendedSourceAdapter('http://169.254.169.254/latest/meta-data/') === undefined,
    'registry-x: 拒绝云元数据',
  )
  assert(
    findExtendedSourceAdapter('https://169.254.169.254/latest/meta-data') === undefined,
    'registry-x: metadata 主机非 feed',
  )
  // 播客：私有地址默认拒绝，显式 allow 后放行（测试走 env 追加）
  const feedUrl = `http://127.0.0.1:1/feed.xml`
  assert(findExtendedSourceAdapter(feedUrl) === undefined, 'registry-x: 回环 feed 默认拒绝')
  process.env.BIBI_PODCAST_EXTRA_HOSTS = '127.0.0.1'
  assert(findExtendedSourceAdapter(feedUrl)?.id === 'podcast', 'registry-x: env 追加后放行')
  assert(findExtendedSourceAdapter('https://feeds.megaphone.fm/showid')?.id === 'podcast', 'registry-x: feeds. 主机')
  assert(findExtendedSourceAdapter('https://example.com/episode.html') === undefined, 'registry-x: 普通网页非 feed')
}

// ---------- 3. 社媒骨架：URL parser 与错误路径 ----------
console.log(`[section] social`)
{
  const douyinNote = new URL('https://www.douyin.com/note/7301234567890123456')
  assert(parseDouyinSource(douyinNote)?.kind === 'imageText', 'douyin: /note/ 识别为图文')
  assert(parseDouyinSource(new URL('https://www.douyin.com/video/7309'))?.kind === 'video', 'douyin: /video/ 识别')
  await expectSourceError(
    douyinAdapter.fetch('https://www.douyin.com/video/7309'),
    'AUTH_REQUIRED',
    'douyin: 无 cookie AUTH_REQUIRED',
  )
  process.env.BIBI_DOUYIN_COOKIE = 'SESSDATA=demo'
  await expectSourceError(
    douyinAdapter.fetch('https://www.douyin.com/video/7309'),
    'SOURCE_UNAVAILABLE',
    'douyin: 有 cookie 也明示未实现',
  )
  delete process.env.BIBI_DOUYIN_COOKIE
  await expectSourceError(
    douyinAdapter.fetch('https://www.douyin.com/other'),
    'SOURCE_UNAVAILABLE',
    'douyin: 非视频路径',
  )

  assert(parseKuaishouSource(new URL('https://v.kuaishou.com/fmabc'))?.videoId === 'fmabc', 'kuaishou: 短链')
  await expectSourceError(
    kuaishouAdapter.fetch('https://www.kuaishou.com/short-video/3xab'),
    'AUTH_REQUIRED',
    'kuaishou: AUTH_REQUIRED',
  )

  assert(
    parseXiaohongshuSource(new URL('https://www.xiaohongshu.com/discovery/item/abc99'))?.noteId === 'abc99',
    'xhs: discovery/item',
  )
  await expectSourceError(
    xiaohongshuAdapter.fetch('https://www.xiaohongshu.com/explore/abc99'),
    'AUTH_REQUIRED',
    'xhs: AUTH_REQUIRED',
  )

  assert(
    parseWechatSource(new URL('https://mp.weixin.qq.com/s?__biz=MzA1&mid=22&idx=1&sn=ab'))?.kind === 'article',
    'wechat: s?__biz 形态',
  )
  await expectSourceError(
    wechatAdapter.fetch('https://mp.weixin.qq.com/s/abcDEF'),
    'AUTH_REQUIRED',
    'wechat: AUTH_REQUIRED',
  )
}

// ---------- 4. ASR mock（真实 HTTP） ----------
const whisperMock = createWhisperMock()
const asrPort = await listenRandom(whisperMock.server)
process.env.BIBI_ASR_BASE_URL = `http://127.0.0.1:${asrPort}`
process.env.BIBI_ASR_MODEL = 'whisper-mock'

function defaultWhisperHandler() {
  return {
    status: 200,
    payload: {
      task: 'transcribe',
      language: 'en',
      duration: 5.2,
      text: 'Hello from mock whisper',
      segments: [
        { start: 0.2, end: 2.6, text: ' Hello from mock' },
        { start: 2.6, end: 5.2, text: ' whisper' },
      ],
    },
  }
}
whisperMock.setHandler(() => defaultWhisperHandler())

assert(resolveAsrConfig()?.model === 'whisper-mock', 'asr: 配置解析（BIBI_ASR_* 优先）')

// ---------- 5. 本地存储：fileId 绑定 / 断点续传 / 同名隔离 ----------
console.log(`[section] store`)
{
  assert(isValidFileId('up_0123456789abcdef0123456789') === false, 'store: 非法 fileId 拒绝')
  const sameName = 'lecture.mp3'

  const s1 = await initUpload({ filename: sameName, size: 10 })
  const s2 = await initUpload({ filename: sameName, size: 6 })
  assert(isValidFileId(s1.fileId) && isValidFileId(s2.fileId), 'store: 合法 fileId')
  assert(s1.fileId !== s2.fileId, 'store: 同名文件产生不同 fileId（不串播）')
  assert(s1.receivedBytes === 0 && s1.status === 'pending', 'store: 初始状态')

  // 冲突 offset
  const conflict = await appendChunk(s1.fileId, 4, Buffer.alloc(1)).then(
    () => ({ error: null }),
    (error) => ({ error }),
  )
  assert(conflict.error instanceof UploadStoreError && conflict.error.statusCode === 409, 'store: 错误 offset 409')
  assert(conflict.error.receivedBytes === 0, 'store: 冲突带 receivedBytes')

  await appendChunk(s1.fileId, 0, Buffer.from('01234'))
  await appendChunk(s1.fileId, 5, Buffer.from('56789'))

  // 跨进程可见（重启后续传的存储基础：状态落盘）
  const registerPath = path.resolve(import.meta.dirname, '../../__fixtures__/register.mjs')
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      registerPath,
      '--input-type=module',
      '-e',
      `
      const { getSessionReceivedBytes } = await import('${path.resolve('lib/storage/localStore.ts')}')
      const received = await getSessionReceivedBytes('${s1.fileId}')
      console.log('RECEIVED=' + received)
    `,
    ],
    { encoding: 'utf8', cwd: process.cwd(), timeout: 60_000 },
  )
  const childOut = (child.stdout || '').match(/RECEIVED=(\d+)/)
  assert(childOut?.[1] === '10', 'store: 子进程读到落盘 offset（重启后续传基础）', child.stderr?.slice(0, 200))

  const completed1 = await completeUpload(s1.fileId)
  assert(completed1.status === 'completed' && completed1.receivedBytes === 10, 'store: complete 终态')
  assert(
    completed1.container === 'unknown' || completed1.container === 'subtitle',
    'store: 10 字节文本嗅探',
    completed1.container,
  )

  // 同名文件各自的 blob 隔离
  await appendChunk(s2.fileId, 0, Buffer.from('abcdef'))
  const resolved1 = await resolveCompletedUpload(s1.fileId)
  const s2Completed = await completeUpload(s2.fileId)
  assert(resolved1.path.includes(s1.fileId) && !resolved1.path.includes('lecture'), 'store: blob 路径只由 fileId 派生')
  assert(s2Completed.receivedBytes === 6, 'store: 第二会话独立计数')

  // 未完成会话不可 resolve
  const s3 = await initUpload({ filename: 'x.mp3', size: 100 })
  assert((await resolveCompletedUpload(s3.fileId)) === null, 'store: 未完成不可读取')

  // 并发同 offset PUT：串行锁保证只成功一次，blob 不被双写损坏
  const s4 = await initUpload({ filename: 'race.mp3', size: 10 })
  const raceResults = await Promise.allSettled([
    appendChunk(s4.fileId, 0, Buffer.from('AAAAA')),
    appendChunk(s4.fileId, 0, Buffer.from('BBBBB')),
  ])
  const raceWinners = raceResults.filter((result) => result.status === 'fulfilled')
  const raceLosers = raceResults.filter((result) => result.status === 'rejected')
  assert(raceWinners.length === 1 && raceLosers.length === 1, 'store: 并发同 offset 恰好一个成功')
  assert(
    raceLosers[0].reason instanceof UploadStoreError && raceLosers[0].reason.statusCode === 409,
    'store: 并发败者收到 409',
  )
  const raceStatus = await getSessionReceivedBytes(s4.fileId)
  assert(raceStatus === 5, 'store: blob 只被追加一次（5 字节）', String(raceStatus))
  await appendChunk(s4.fileId, 5, Buffer.from('CCCCC'))
  const raceCompleted = await completeUpload(s4.fileId)
  assert(raceCompleted.receivedBytes === 10, 'store: 竞态后续传与 complete 一致')
}

import { UploadStoreError as UploadStoreErrorLocal } from '~/lib/storage/localStore.ts'

// ---------- 6. 真实媒体上传 → complete 探测 → adapter 转写 ----------
console.log(`[section] media`)
async function uploadAndComplete(filePath, filename) {
  const { readFile } = await import('node:fs/promises')
  const bytes = await readFile(filePath)
  const session = await initUpload({ filename, size: bytes.length })
  const chunkSize = 5 * 1024 * 1024
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    await appendChunk(session.fileId, offset, bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  }
  return completeUpload(session.fileId)
}

if (fixtures.voiceMp3 && hasFfprobe) {
  whisperMock.setHandler(() => defaultWhisperHandler())
  const meta = await uploadAndComplete(fixtures.voiceMp3, 'kin46-voice.mp3')
  assert(
    meta.kind === 'audio' && meta.container === 'mp3',
    'media: mp3 容器/类型识别',
    JSON.stringify({ kind: meta.kind, container: meta.container }),
  )
  assert(
    meta.duration !== undefined && meta.duration > 1 && meta.duration < 30,
    'media: mp3 ffprobe 时长',
    String(meta.duration),
  )
  assert(meta.hasAudio === true, 'media: mp3 有音轨')

  const doc = await localFileAdapter.fetch(buildLocalFileUrl(meta.fileId))
  assert(doc.service === 'local' && doc.title === 'kin46-voice.mp3', 'media: adapter title')
  assert(doc.transcript.length === 2 && doc.transcript[0].text === 'Hello from mock', 'media: ASR transcript 映射')
  assert(
    doc.duration !== undefined && doc.duration > 1 && doc.duration < 30,
    'media: duration 来自 ffprobe 实测',
    String(doc.duration),
  )
  assert(doc.sourceRef === `local:file:${meta.fileId}`, 'media: sourceRef')
  assert(localFileAdapter.match(new URL(buildLocalFileUrl(meta.fileId))), 'media: adapter match')
  assert(parseLocalFileId(new URL(buildLocalFileUrl(meta.fileId))) === meta.fileId, 'media: fileId 反解析')
  whisperMock.resetCalls()
} else {
  console.log('SKIP: say/ffmpeg 缺失，mp3 链路跳过')
}

if (hasFfmpeg && hasFfprobe) {
  // wav
  const wavPath = path.join(mediaDir, 'voice.wav')
  if (voiceAiff) {
    ffmpeg(['-i', voiceAiff, '-codec:a', 'pcm_s16le', wavPath])
    const wavMeta = await uploadAndComplete(wavPath, 'kin46-voice.wav')
    assert(wavMeta.container === 'wav' && wavMeta.kind === 'audio', 'media: wav 识别')
  }
  // m4a
  if (voiceAiff) {
    const m4aPath = path.join(mediaDir, 'voice.m4a')
    ffmpeg(['-i', voiceAiff, '-codec:a', 'aac', m4aPath])
    const m4aMeta = await uploadAndComplete(m4aPath, 'kin46-voice.m4a')
    assert(m4aMeta.container === 'm4a' && m4aMeta.kind === 'audio', 'media: m4a 识别')
  }

  // 无音轨视频 fail closed
  const silentVideo = path.join(mediaDir, 'silent.mp4')
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=128x128:rate=10', '-pix_fmt', 'yuv420p', silentVideo])
  const silentMeta = await uploadAndComplete(silentVideo, 'kin46-silent.mp4')
  assert(silentMeta.kind === 'video' && silentMeta.hasAudio === false, 'media: 无音轨视频探测')
  await expectSourceError(
    localFileAdapter.fetch(buildLocalFileUrl(silentMeta.fileId)),
    'NO_TRANSCRIPT',
    'media: 无音轨 fail closed（不进 ASR）',
  )

  // 有音轨视频
  if (voiceAiff) {
    const avVideo = path.join(mediaDir, 'av.mp4')
    ffmpeg([
      '-i',
      voiceAiff,
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=5:size=128x128:rate=10',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-shortest',
      avVideo,
    ])
    const avMeta = await uploadAndComplete(avVideo, 'kin46-av.mp4')
    assert(avMeta.kind === 'video' && avMeta.hasAudio === true, 'media: 带音轨视频探测')
    const avDoc = await localFileAdapter.fetch(buildLocalFileUrl(avMeta.fileId))
    assert(avDoc.transcript.length === 2, 'media: 视频音轨转写')
  }

  // FLV 魔数：伪 flv 上传 → 容器识别 + remux 失败保留原文件（不阻塞上传）
  const fakeFlv = path.join(mediaDir, 'fake.flv')
  writeFileSync(fakeFlv, Buffer.concat([Buffer.from('FLV\x01\x05\x00\x00\x00\x09'), Buffer.alloc(64, 7)]))
  const flvMeta = await uploadAndComplete(fakeFlv, 'kin46-fake.flv')
  assert(flvMeta.kind === 'video', 'media: flv 归为 video')
  assert(
    (flvMeta.notes || []).some((note) => note.includes('flv remux failed')) || flvMeta.remuxedTo === 'mp4',
    'media: flv remux 结果有备注（本例伪文件必然失败）',
    JSON.stringify(flvMeta.notes),
  )
  const flvSniff = await sniffContainer(fakeFlv)
  assert(flvSniff.container === 'flv', 'media: FLV 魔数嗅探')
}

// ---------- 7. ASR 失败路径 fail closed ----------
console.log(`[section] asr-fail`)
if (fixtures.voiceMp3) {
  whisperMock.setHandler(() => ({ status: 500, payload: { error: { message: 'gpu exploded' } } }))
  await expectSourceError(
    transcribeAudioFile(fixtures.voiceMp3, { filename: 'x.mp3' }),
    'NO_TRANSCRIPT',
    'asr: 500 → NO_TRANSCRIPT',
  )
  whisperMock.setHandler(() => ({ status: 429, payload: { error: { message: 'slow down' } } }))
  await expectSourceError(
    transcribeAudioFile(fixtures.voiceMp3, { filename: 'x.mp3' }),
    'RATE_LIMITED',
    'asr: 429 → RATE_LIMITED',
  )
  whisperMock.setHandler(() => ({ status: 200, payload: { text: '', segments: [] } }))
  await expectSourceError(
    transcribeAudioFile(fixtures.voiceMp3, { filename: 'x.mp3' }),
    'NO_TRANSCRIPT',
    'asr: 空转写 → NO_TRANSCRIPT',
  )

  // 未配置 ASR：占位/空 key 一律视为未配置
  const savedKey = process.env.BIBI_ASR_API_KEY
  delete process.env.BIBI_ASR_API_KEY
  delete process.env.OPENAI_COMPATIBLE_API_KEY
  const savedOpenAi = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY
  assert(resolveAsrConfig() === null, 'asr: 无 key 判定未配置')
  await expectSourceError(
    transcribeAudioFile(fixtures.voiceMp3, { filename: 'x.mp3' }),
    'NO_TRANSCRIPT',
    'asr: 未配置 fail closed',
  )
  process.env.BIBI_ASR_API_KEY = savedKey
  process.env.OPENAI_API_KEY = savedOpenAi
  whisperMock.setHandler(() => defaultWhisperHandler())
}

// ---------- 8. 超长音频分段 + offset 合并 ----------
console.log(`[section] segment`)
if (fixtures.bigMp3) {
  const { stat } = await import('node:fs/promises')
  const size = (await stat(fixtures.bigMp3)).size
  assert(size > 24 * 1024 * 1024, 'segment: fixture 超过单请求上限', String(size))
  whisperMock.resetCalls()
  whisperMock.setHandler(() => ({
    status: 200,
    payload: {
      language: 'en',
      duration: 600,
      text: 'segment text',
      segments: [{ start: 1.5, end: 3.5, text: 'chunk content' }],
    },
  }))
  const bigSession = await uploadAndComplete(fixtures.bigMp3, 'kin46-big.mp3')
  assert(
    bigSession.duration !== undefined && bigSession.duration > 3000,
    'segment: ffprobe 长音频时长',
    String(bigSession.duration),
  )
  const bigDoc = await localFileAdapter.fetch(buildLocalFileUrl(bigSession.fileId))
  assert(whisperMock.calls.length >= 2, 'segment: 多次 ASR 分段请求', String(whisperMock.calls.length))
  assert(
    whisperMock.calls.every((call) => call.hasFilePart && call.hasModelPart && call.hasVerboseFormat),
    'segment: multipart 字段齐全',
  )
  const offsets = bigDoc.transcript.map((segment) => segment.start)
  assert(
    offsets.some((start) => start >= 600),
    'segment: 第二段 offset 合并（>=600s）',
    JSON.stringify(offsets.slice(0, 5)),
  )
  assert(bigDoc.duration !== undefined && bigDoc.duration > 3000, 'segment: 文档时长')
  whisperMock.setHandler(() => defaultWhisperHandler())

  // ffmpeg 可执行性真实探测：BIBI_FFMPEG_PATH 指向不存在的二进制时 fail closed
  const savedFfmpegPath = process.env.BIBI_FFMPEG_PATH
  process.env.BIBI_FFMPEG_PATH = '/nonexistent/bibi-kin46/ffmpeg'
  await expectSourceError(
    transcribeAudioFile(fixtures.bigMp3, { filename: 'x.mp3' }),
    'NO_TRANSCRIPT',
    'segment: ffmpeg 不可用被真实探测（而非恒真检查）',
  )
  if (savedFfmpegPath === undefined) {
    delete process.env.BIBI_FFMPEG_PATH
  } else {
    process.env.BIBI_FFMPEG_PATH = savedFfmpegPath
  }
} else {
  console.log('SKIP: ffmpeg 缺失，超长分段跳过')
}

// ---------- 9. 字幕文件直读（SRT fixture 全链路） ----------
console.log(`[section] srt-file`)
{
  const srtContent = [
    '1',
    '00:00:00,500 --> 00:00:02,000',
    '字幕直读第一条',
    '',
    '2',
    '00:00:02,000 --> 00:00:04,000',
    '字幕直读第二条',
    '',
  ].join('\n')
  const session = await initUpload({ filename: 'kin46.srt', size: Buffer.byteLength(srtContent) })
  await appendChunk(session.fileId, 0, Buffer.from(srtContent, 'utf8'))
  await completeUpload(session.fileId)
  const doc = await localFileAdapter.fetch(buildLocalFileUrl(session.fileId))
  assert(doc.transcript.length === 2, 'srt-file: 直读两条')
  assert(doc.transcript[0].start === 0.5 && doc.transcript[0].text === '字幕直读第一条', 'srt-file: 内容')
  assert(doc.duration === 4, 'srt-file: 时长取末条 end')
  assert(doc.service === 'local', 'srt-file: service')

  // ingest transcript 模式：subtitleItems 是 /api/sumup 摘要输入同款契约
  const ingest = await runIngest({ fileId: session.fileId }, { mode: 'transcript' })
  assert(
    ingest.subtitleItems.length === 1 && ingest.subtitleItems[0].text.includes('字幕直读'),
    'ingest: 分组 subtitleItems',
  )
  assert(ingest.source.sourceRef === doc.sourceRef, 'ingest: sourceRef 透传')
}

// ---------- 10. podcast RSS ----------
console.log(`[section] podcast`)
{
  const tinyMp3 = fixtures.voiceMp3
  if (tinyMp3) {
    const { readFile } = await import('node:fs/promises')
    const mp3Bytes = await readFile(tinyMp3)
    let rssHit = 0
    let mp3Hit = 0
    let redirectHit = 0
    const mediaServer = createHttpServer(async (req, res) => {
      const url = new URL(req.url, 'http://x')
      if (url.pathname === '/feed.xml') {
        rssHit += 1
        const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title><![CDATA[KIN46 Test Show]]></title>
    <itunes:image href="http://127.0.0.1:${asrPort}/cover.jpg"/>
    <item>
      <title>Episode 2 (latest)</title>
      <guid>guid-ep2</guid>
      <itunes:duration>1:02:30</itunes:duration>
      <pubDate>Tue, 22 Sep 2026 10:00:00 GMT</pubDate>
      <enclosure url="http://127.0.0.1:${mediaPortValue}/audio-ep2.mp3" type="audio/mpeg" length="${mp3Bytes.length}"/>
    </item>
    <item>
      <title>Episode 1</title>
      <guid>guid-ep1</guid>
      <itunes:duration>600</itunes:duration>
      <enclosure url="http://127.0.0.1:${mediaPortValue}/audio-ep1.mp3" type="audio/mpeg" length="${mp3Bytes.length}"/>
    </item>
    <item>
      <title>Text only item</title>
      <guid>guid-ep0</guid>
      <description>no audio here</description>
    </item>
  </channel>
</rss>`
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(rss)
        return
      }
      if (url.pathname === '/feed-ssrf.xml') {
        const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>SSRF Probe Feed</title>
    <item>
      <title>Metadata target</title>
      <guid>guid-ssrf-meta</guid>
      <enclosure url="http://169.254.169.254/latest/meta-data/x.mp3" type="audio/mpeg" length="10"/>
    </item>
    <item>
      <title>Loopback hostname</title>
      <guid>guid-ssrf-localhost</guid>
      <enclosure url="http://localhost:9/x.mp3" type="audio/mpeg" length="10"/>
    </item>
    <item>
      <title>Redirect to internal</title>
      <guid>guid-ssrf-redirect</guid>
      <enclosure url="http://127.0.0.1:${mediaPortValue}/audio-redirect.mp3" type="audio/mpeg" length="10"/>
    </item>
  </channel>
</rss>`
        res.writeHead(200, { 'content-type': 'application/xml' })
        res.end(rss)
        return
      }
      if (url.pathname === '/audio-redirect.mp3') {
        redirectHit += 1
        res.writeHead(302, { location: 'http://169.254.169.254/x.mp3' })
        res.end()
        return
      }
      if (url.pathname.startsWith('/audio-')) {
        mp3Hit += 1
        res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': mp3Bytes.length })
        res.end(mp3Bytes)
        return
      }
      res.writeHead(404)
      res.end('nope')
    })
    globalThis.mediaPortValue = await listenRandom(mediaServer)

    const feedUrl = `http://127.0.0.1:${globalThis.mediaPortValue}/feed.xml`
    const doc = await podcastAdapter.fetch(feedUrl)
    assert(doc.service === 'podcast', 'podcast: service')
    assert(doc.title === 'Episode 2 (latest)', 'podcast: 缺省选最新一条', doc.title)
    assert(doc.duration === 3750, 'podcast: itunes:duration 1:02:30 → 3750s', String(doc.duration))
    assert(doc.images?.[0]?.url?.includes('/cover.jpg'), 'podcast: show 封面')
    assert(doc.transcript.length === 2, 'podcast: ASR transcript')
    assert(doc.sourceRef.startsWith('podcast:feed:'), 'podcast: sourceRef 形态')
    assert(mp3Hit === 1 && rssHit === 1, 'podcast: 下载一次')
    assert(doc.sourceUrl === feedUrl, 'podcast: sourceUrl 回指 feed')

    // ?ep= 选集（序号与 guid 前缀）
    const ep1 = await podcastAdapter.fetch(`${feedUrl}?ep=2`)
    assert(ep1.title === 'Episode 1', 'podcast: ?ep= 序号选集')
    const epByGuid = await podcastAdapter.fetch(`${feedUrl}?ep=guid-ep2`)
    assert(epByGuid.title === 'Episode 2 (latest)', 'podcast: ?ep= guid 选集')

    // 无音频条目 fail closed
    await expectSourceError(podcastAdapter.fetch(`${feedUrl}?ep=3`), 'NO_TRANSCRIPT', 'podcast: 无附件条目 fail closed')

    // SSRF：enclosure 指向云元数据 / 回环主机名，必须在下载前被拒
    const ssrfFeed = `http://127.0.0.1:${globalThis.mediaPortValue}/feed-ssrf.xml`
    await expectSourceError(
      podcastAdapter.fetch(`${ssrfFeed}?ep=1`),
      'SOURCE_UNAVAILABLE',
      'podcast: enclosure 云元数据地址被拒',
    )
    await expectSourceError(
      podcastAdapter.fetch(`${ssrfFeed}?ep=2`),
      'SOURCE_UNAVAILABLE',
      'podcast: enclosure localhost 被拒',
    )
    // 重定向跳到内网地址：每一跳复检，302 已收到但目标不被跟随下载
    await expectSourceError(
      podcastAdapter.fetch(`${ssrfFeed}?ep=3`),
      'SOURCE_UNAVAILABLE',
      'podcast: 重定向目标内网地址被拒',
    )
    assert(redirectHit === 1, 'podcast: 重定向 302 只发生一次（后续跳被拦）', String(redirectHit))
  } else {
    console.log('SKIP: 无 mp3 fixture，podcast 下载链路跳过')
  }
}

// ---------- 11. 无字幕 YouTube ASR provider ----------
console.log(`[section] yt-asr`)
{
  // 假 yt-dlp：产出真实 mp3 + info.json，验证 provider 全链路（不触网）
  if (fixtures.voiceMp3) {
    const { readFile } = await import('node:fs/promises')
    const fakeBinDir = path.join(workRoot, 'fakebin')
    await import('node:fs/promises').then((fs) => fs.mkdir(fakeBinDir, { recursive: true }))
    const fakeYtDlp = path.join(fakeBinDir, 'fake-ytdlp.sh')
    const mp3Bytes = await readFile(fixtures.voiceMp3)
    // provider 的输出目录是确定性的：tmpdir()/bibi-ytasr-<sanitized videoId>
    const outDirArg = path.join(tmpdir(), 'bibi-ytasr-mockNoSub1')
    writeFileSync(
      fakeYtDlp,
      [
        '#!/bin/sh',
        `mkdir -p "${outDirArg}"`,
        `cp "${fixtures.voiceMp3}" "${outDirArg}/audio.mp3"`,
        `printf '%s' '{"title":"Mock No-Sub Video","duration":5.2}' > "${outDirArg}/audio.info.json"`,
        'exit 0',
      ].join('\n'),
    )
    await import('node:fs/promises').then((fs) => fs.chmod(fakeYtDlp, 0o755))
    process.env.BIBI_YTDLP_PATH = fakeYtDlp

    // savesubs 无字幕（formats 空 → null）→ ASR provider 兜底
    const realFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      if (url.includes('savesubs.com/action/extract')) {
        return new Response(JSON.stringify({ response: { formats: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return realFetch(input, init)
    }
    try {
      const result = await youtubeAsrProvider.fetchTranscript('mockNoSub1')
      assert(result?.transcript.length === 2, 'yt-asr: provider 转写', JSON.stringify(result?.transcript?.slice(0, 1)))
      assert(result?.meta?.title === 'Mock No-Sub Video', 'yt-asr: info.json 元数据')

      whisperMock.resetCalls()
      const doc = await youtubeAsrAdapter.fetch('https://www.youtube.com/watch?v=mockNoSub1')
      assert(doc.title === 'Mock No-Sub Video' && doc.service === 'youtube', 'yt-asr: adapter 文档')
      assert(doc.transcript.length === 2, 'yt-asr: adapter transcript')
      assert(whisperMock.calls.length === 1, 'yt-asr: 有字幕 provider null 才走 ASR（只调一次）')

      // ASR 失败 → 无字幕链 fail closed：NO_TRANSCRIPT 且无伪造内容
      whisperMock.setHandler(() => ({ status: 500, payload: { error: { message: 'down' } } }))
      await expectSourceError(
        youtubeAsrAdapter.fetch('https://www.youtube.com/watch?v=mockNoSub1'),
        'NO_TRANSCRIPT',
        'yt-asr: ASR 失败 fail closed',
      )
    } finally {
      globalThis.fetch = realFetch
      whisperMock.setHandler(() => defaultWhisperHandler())
      delete process.env.BIBI_YTDLP_PATH
    }
  } else {
    console.log('SKIP: 无 mp3 fixture，youtube-asr 跳过')
  }
}

// ---------- 12. ingest summary：fast 路径（mock chat completions 真实 HTTP） ----------
console.log(`[section] summary-fast`)
{
  const chatCalls = []
  const chatServer = createHttpServer(async (req, res) => {
    const body = JSON.parse((await readRequestBody(req)).toString('utf8') || '{}')
    chatCalls.push({ url: req.url, model: body.model, messages: body.messages?.length })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'chatcmpl-kin46',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '## Summary\n- mock bullet one\n- mock bullet two' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      }),
    )
  })
  const chatPort = await listenRandom(chatServer)

  const srtContent = [
    '1',
    '00:00:00,000 --> 00:00:02,000',
    'first line for summary',
    '',
    '2',
    '00:00:02,000 --> 00:00:04,000',
    'second line for summary',
    '',
  ].join('\n')
  const session = await initUpload({ filename: 'sum.srt', size: Buffer.byteLength(srtContent) })
  await appendChunk(session.fileId, 0, Buffer.from(srtContent, 'utf8'))
  await completeUpload(session.fileId)

  const result = await runIngest(
    { fileId: session.fileId },
    {
      mode: 'summary',
      userKey: 'sk-kin46-mock-key-00000000',
      baseUrl: `http://127.0.0.1:${chatPort}`,
      model: 'mock-summary-model',
      outputLanguage: '中文',
    },
  )
  assert(result.summary?.plan === 'fast', 'ingest-summary: 单 chunk fast 路径')
  assert(result.summary?.text.includes('## Summary'), 'ingest-summary: 摘要文本')
  assert(
    chatCalls.length === 1 && chatCalls[0].url.includes('/chat/completions'),
    'ingest-summary: chat 调用',
    JSON.stringify(chatCalls),
  )
  assert(result.subtitleItems.length >= 1, 'ingest-summary: subtitleItems 同步返回')

  // fast 路径缓存降级（无 Upstash env 时仅告警不失败）
  chatServer.close()
}

// ---------- 13. ingest summary：job 路径（多 chunk，mock Upstash） ----------
console.log(`[section] summary-job`)
{
  const chatServer = createHttpServer(async (req, res) => {
    await readRequestBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'chatcmpl-kin46-job',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-summary-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '## Summary\n- job bullet alpha\n- job bullet beta' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
      }),
    )
  })
  const chatPort = await listenRandom(chatServer)

  const upstashPort = 32700 + (process.pid % 300)
  const { spawn } = await import('node:child_process')
  const upstashChild = spawn(process.execPath, ['scripts/mock-upstash.mjs', '--port', String(upstashPort)], {
    cwd: process.cwd(),
    stdio: 'ignore',
    detached: false,
  })
  let upstashReady = false
  for (let attempt = 0; attempt < 30 && !upstashReady; attempt += 1) {
    upstashReady = await fetch(`http://127.0.0.1:${upstashPort}`, { method: 'POST', body: JSON.stringify([['ping']]) })
      .then((res) => res.ok)
      .catch(() => false)
    if (!upstashReady) {
      await sleep(200)
    }
  }
  assert(upstashReady, 'job: mock Upstash 就绪')

  process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${upstashPort}`
  process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token'
  process.env.UPSTASH_RATE_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL
  process.env.UPSTASH_RATE_REDIS_REST_TOKEN = 'mock-token'

  // 大字幕（>12KB）确保多 chunk
  const lines = []
  for (let index = 0; index < 400; index += 1) {
    lines.push(
      `${index + 1}`,
      `00:00:${String(Math.floor(index / 20)).padStart(2, '0')},${String((index * 50) % 1000).padStart(
        3,
        '0',
      )} --> 00:00:59,999`,
      `这是第 ${index} 条用于多 chunk 分段的测试字幕内容，长度足够触发装箱切分。`,
      '',
    )
  }
  const bigSrt = lines.join('\n')
  const session = await initUpload({ filename: 'big.srt', size: Buffer.byteLength(bigSrt) })
  await appendChunk(session.fileId, 0, Buffer.from(bigSrt, 'utf8'))
  await completeUpload(session.fileId)

  const result = await runIngest(
    { fileId: session.fileId },
    {
      mode: 'summary',
      userKey: 'sk-kin46-mock-key-00000000',
      baseUrl: `http://127.0.0.1:${chatPort}`,
      model: 'mock-summary-model',
    },
  )
  assert(result.summary?.plan === 'job', 'job: 多 chunk 进 job 管线', result.summary?.plan)
  assert(result.summary?.text?.includes('## Summary'), 'job: map-reduce 摘要产出', JSON.stringify(result.summary))
  assert(typeof result.summary?.jobId === 'string' && result.summary.jobId.startsWith('job_'), 'job: jobId 形态')

  upstashChild.kill()
  chatServer.close()
}

// ---------- 收尾 ----------
whisperMock.server.close()
rmSync(workRoot, { recursive: true, force: true })

console.log(`\nkin46 fixtures: ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log('failures:')
  for (const failure of failures) {
    console.log(`  - ${failure}`)
  }
}
// 断言只记录不抛出，走到这里说明流程完整；mock server/子进程会挂住事件循环，显式退出
process.exit(failed > 0 ? 1 : 0)
