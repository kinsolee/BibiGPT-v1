// 评审修复专项单测（PR #12 Round 2）：
// P1-1 URL 守卫 / P2-4 真实 MIME / P1-5 批次 deadline 与续跑 / P1-3 双口径内容解析。
import path from 'node:path'

import { analyzeFrameBatch } from '../analyze'
import { loadFrameImage } from '../generate'
import { resolveVisionContent } from '../media'
import { assertSafePublicImageUrl, isSafePublicImageUrl } from '../urlGuard'
import { check, checkEqual, resetSuite, summary } from './harness'
import { createSupabaseStub, makeContentRow } from './supabaseStub'

function httpResponse(body: ArrayBuffer, contentType: string | null, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => body,
  } as unknown as Response
}

async function run() {
  resetSuite()
  console.log('review fixes (url guard / mime / batch deadline / dual sourceRef)')
  process.env.BIBI_VISION_MODEL = 'test-model'
  process.env.BIBI_VISION_ANALYZE_CONCURRENCY = '1'

  // ---- P1-1 URL 守卫 ----
  check('公网 https 通过', isSafePublicImageUrl('https://i.ytimg.com/vi/x/mqdefault.jpg'))
  check('公网 http 通过', isSafePublicImageUrl('http://example.com/a.png'))
  check('拒绝 file scheme', !isSafePublicImageUrl('file:///etc/passwd'))
  check('拒绝 data scheme', !isSafePublicImageUrl('data:image/png;base64,xxx'))
  check('拒绝 localhost', !isSafePublicImageUrl('http://localhost:3000/x'))
  check('拒绝 127.0.0.1', !isSafePublicImageUrl('http://127.0.0.1/x'))
  check('拒绝 10/8', !isSafePublicImageUrl('http://10.1.2.3/x'))
  check('拒绝 192.168/16', !isSafePublicImageUrl('http://192.168.1.1/x'))
  check('拒绝 172.16/12', !isSafePublicImageUrl('http://172.16.0.1/x'))
  check('拒绝 169.254 metadata', !isSafePublicImageUrl('http://169.254.169.254/latest/meta-data'))
  check('拒绝 ::1', !isSafePublicImageUrl('http://[::1]/x'))
  let guardThrew = false
  try {
    assertSafePublicImageUrl('http://127.0.0.1:8080/x')
  } catch {
    guardThrew = true
  }
  check('assert 对私网抛错', guardThrew)

  // ---- P2-4 MIME 透传 + 守卫前置 ----
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer
  let fetchCalled = 0
  const fetchImpl = (async () => {
    fetchCalled += 1
    return httpResponse(pngBytes, 'image/png')
  }) as unknown as typeof fetch
  const pngImage = await loadFrameImage({ setId: null, url: 'https://cdn.example.com/pic.png' }, { fetchImpl })
  checkEqual('PNG MIME 透传', pngImage.mime, 'image/png')
  const noHeader = await loadFrameImage(
    { setId: null, url: 'https://cdn.example.com/pic' },
    {
      fetchImpl: (async () => httpResponse(pngBytes, null)) as unknown as typeof fetch,
    },
  )
  checkEqual('缺 content-type 安全回退 JPEG', noHeader.mime, 'image/jpeg')
  const badHeader = await loadFrameImage(
    { setId: null, url: 'https://cdn.example.com/pic' },
    {
      fetchImpl: (async () => httpResponse(pngBytes, 'text/html')) as unknown as typeof fetch,
    },
  )
  checkEqual('非 image/* 回退 JPEG', badHeader.mime, 'image/jpeg')
  const before = fetchCalled
  let unsafeRejected = false
  try {
    await loadFrameImage({ setId: null, url: 'http://169.254.169.254/latest/meta-data/' }, { fetchImpl })
  } catch {
    unsafeRejected = true
  }
  check('私网 URL 未触达 fetch 即拒绝', unsafeRejected && fetchCalled === before)

  // ---- P1-5 批次 deadline：skipped 标记 + 续跑补齐 ----
  const supabase = createSupabaseStub()
  const content = makeContentRow() as any
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const batchDir = path.join(tmpdir(), `bibi-vision-batch-${Date.now()}`)
  const setId = 'kfset_aaaabbbbcccc'
  await mkdir(path.join(batchDir, 'sets', setId), { recursive: true })
  for (let idx = 0; idx < 4; idx += 1) {
    await writeFile(path.join(batchDir, 'sets', setId, `frame-00${idx}.jpg`), Buffer.from(`batch-frame-bytes-${idx}`))
  }
  const prevVisionDir = process.env.BIBI_VISION_DIR
  process.env.BIBI_VISION_DIR = batchDir
  const frames = [0, 1, 2, 3].map((idx) => ({
    frameId: `kf_${idx}`,
    idx,
    time: idx,
    setId,
    file: `frame-00${idx}.jpg`,
  }))
  const slowVlm = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 2600))
    return { ocr: '', description: '慢速帧', tags: [] }
  }) as any
  process.env.BIBI_VISION_BATCH_DEADLINE_MS = '5000'
  const firstBatch = await analyzeFrameBatch({
    supabase,
    userId: 'user-1',
    content,
    frames,
    model: 'test-model',
    vlmFn: slowVlm,
  })
  checkEqual('时限内只完成前两帧', [firstBatch.okCount, firstBatch.skippedCount], [2, 2])
  checkEqual('其余帧无失败', firstBatch.errorCount, 0)

  const resumeBatch = await analyzeFrameBatch({
    supabase,
    userId: 'user-1',
    content,
    frames,
    model: 'test-model',
    vlmFn: slowVlm,
  })
  checkEqual('续跑命中已完成帧缓存', resumeBatch.cachedCount, 2)
  checkEqual('续跑补齐剩余帧', resumeBatch.okCount, 2)
  checkEqual('续跑后无 skipped', resumeBatch.skippedCount, 0)
  delete process.env.BIBI_VISION_BATCH_DEADLINE_MS
  delete process.env.BIBI_VISION_ANALYZE_CONCURRENCY
  if (prevVisionDir === undefined) {
    delete process.env.BIBI_VISION_DIR
  } else {
    process.env.BIBI_VISION_DIR = prevVisionDir
  }
  await rm(batchDir, { recursive: true, force: true })

  // ---- P1-3 双口径 sourceRef 解析 ----
  const dualSupabase = createSupabaseStub()
  const rows = [
    {
      id: 'row-raw-yt',
      user_id: 'user-1',
      service: 'youtube',
      source_ref: 'dQw4w9WgXcQ',
      source_page: null,
      table: 'contents',
    },
    {
      id: 'row-canonical-yt',
      user_id: 'user-1',
      service: 'youtube',
      source_ref: 'youtube:video:dQw4w9WgXcQ',
      source_page: null,
      table: 'contents',
    },
    {
      id: 'row-raw-bv',
      user_id: 'user-1',
      service: 'bilibili',
      source_ref: 'BV1GJ411x7h7',
      source_page: '2',
      table: 'contents',
    },
    {
      id: 'row-canonical-bv-p2',
      user_id: 'user-1',
      service: 'bilibili',
      source_ref: 'bilibili:video:BV1GJ411x7h7:p2',
      source_page: null,
      table: 'contents',
    },
    {
      id: 'row-canonical-bv-p1',
      user_id: 'user-1',
      service: 'bilibili',
      source_ref: 'bilibili:video:BV1GJ411x7h7',
      source_page: null,
      table: 'contents',
    },
  ]
  ;(dualSupabase as any).__seedRows(rows)
  const ytRaw = await resolveVisionContent(dualSupabase, 'user-1', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  check(
    'YouTube 找到落库内容（裸/ canonical 双口径其一）',
    ytRaw !== null && ['row-raw-yt', 'row-canonical-yt'].includes((ytRaw as any).id),
    ytRaw && (ytRaw as any).id,
  )
  const bvPaged = await resolveVisionContent(
    dualSupabase,
    'user-1',
    'https://www.bilibili.com/video/BV1GJ411x7h7?p=2',
    '2',
  )
  check(
    'B 站分 P 找到内容',
    bvPaged !== null && ['row-raw-bv', 'row-canonical-bv-p2'].includes((bvPaged as any).id),
    bvPaged && (bvPaged as any).id,
  )
  const bvUnpaged = await resolveVisionContent(dualSupabase, 'user-1', 'https://www.bilibili.com/video/BV1GJ411x7h7')
  checkEqual('B 站无分页号命中 P1 canonical 行', (bvUnpaged as any)?.id, 'row-canonical-bv-p1')

  summary('reviewFixes')
}

export { run as runReviewFixesTests }
