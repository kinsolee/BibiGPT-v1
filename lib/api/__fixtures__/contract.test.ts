// KIN-49 /api/v1 契约 fixture（OpenAPI contract fixture）。
// 运行：node --import ./lib/api/__fixtures__/register.mjs ./lib/api/__fixtures__/contract.test.ts
// 覆盖 submit/status/result/import + 幂等重复提交/未授权/不支持域名/限流等；
// 重型依赖（job engine、Supabase、摘要管线）全部以可注入 fake 替代，
// 等价验证口径与 KIN-42/KIN-46 桩验证一致（本地 Supabase 凭据为占位）。
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import type { NextApiRequest, NextApiResponse } from 'next'
import type { V1Deps } from '../deps'
import { V1Error } from '../errors'
import { handleV1AdminTokenRevoke, handleV1AdminTokens } from '../handlers/adminTokens'
import { handleV1ContentsGet, handleV1TranscriptGet } from '../handlers/contents'
import type { V1ContentReader } from '../handlers/contents'
import { handleV1Import } from '../handlers/import'
import type { V1Importer } from '../handlers/import'
import { handleV1JobsGet } from '../handlers/jobs'
import type { V1JobReader } from '../handlers/jobs'
import { handleV1Submit } from '../handlers/submit'
import type { V1SubmitInput, V1SubmitPipeline } from '../handlers/submit'
import { handleV1WatchLaterList } from '../handlers/watchlater'
import type { V1WatchLaterReader } from '../handlers/watchlater'
import { v1OpenApiSpec } from '../openapi'
import { createMemoryIdempotencyStore } from '../idempotency'
import type { IdempotencyStore } from '../idempotency'
import { createMemoryRateLimiter } from '../ratelimit'
import type { RateLimiter } from '../ratelimit'
import { hashApiToken } from '../tokenStore'
import type { ApiTokenStore, ApiTokenListItem, V1TokenRecord } from '../tokenStore'

// ---------------------------------------------------------------- fake 基础设施

interface RecordedResponse {
  status: number
  body: unknown
  headers: Record<string, string | string[] | undefined>
}

function fakeReq(options: {
  method: string
  headers?: Record<string, string>
  query?: Record<string, string | string[]>
  body?: unknown
}): NextApiRequest {
  return {
    method: options.method,
    headers: options.headers ?? {},
    query: options.query ?? {},
    url: '/api/v1/test',
    body: options.body,
  } as unknown as NextApiRequest
}

function fakeRes(): { res: NextApiResponse; recorded: RecordedResponse } {
  const recorded: RecordedResponse = { status: 0, body: undefined, headers: {} }
  const res = {
    statusCode: 0,
    status(code: number) {
      recorded.status = code
      return res
    },
    json(body: unknown) {
      recorded.body = body
      return res
    },
    setHeader(name: string, value: string | string[] | undefined) {
      recorded.headers[name.toLowerCase()] = value
      return res
    },
    end() {
      return res
    },
  }
  return { res: res as unknown as NextApiResponse, recorded }
}

interface FakeToken {
  plaintext: string
  record: V1TokenRecord
}

function createFakeTokenStore(): { store: ApiTokenStore; tokens: Map<string, FakeToken> } {
  const tokens = new Map<string, FakeToken>()
  const listItem = (token: FakeToken): ApiTokenListItem => ({
    ...token.record,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  })
  return {
    tokens,
    store: {
      async findByTokenHash(tokenHash) {
        const hit = tokens.get(tokenHash)
        return hit ? hit.record : null
      },
      touchLastUsed() {},
      async create({ userId, scope, name }) {
        const plaintext = `bvt_${randomUUID().replace(/-/g, '')}`
        const token: FakeToken = {
          plaintext,
          record: { id: randomUUID(), userId, scope, name: name ?? '', revoked: false },
        }
        tokens.set(await hashApiToken(plaintext), token)
        return { token: plaintext, record: listItem(token) }
      },
      async revoke(tokenId) {
        let revoked = false
        tokens.forEach((token) => {
          if (token.record.id === tokenId) {
            token.record.revoked = true
            revoked = true
          }
        })
        return revoked
      },
      async list() {
        return Array.from(tokens.values()).map(listItem)
      },
    },
  }
}

function alwaysFailRateLimiter(retryAfterSeconds = 30): RateLimiter {
  return {
    limit: async () => ({ success: false, retryAfterSeconds }),
  }
}

interface HarnessOptions {
  rateLimiter?: RateLimiter
  idempotencyStore?: IdempotencyStore
}

interface Harness {
  deps: V1Deps
  readToken: string
  writeToken: string
}

async function makeHarnessAsync(options: HarnessOptions = {}): Promise<Harness> {
  const { store: tokenStore } = createFakeTokenStore()
  const readToken = (
    await tokenStore.create({ userId: '00000000-0000-0000-0000-000000000001', scope: 'read', name: 'r' })
  ).token
  const writeToken = (
    await tokenStore.create({ userId: '00000000-0000-0000-0000-000000000001', scope: 'write', name: 'w' })
  ).token
  const deps: V1Deps = {
    supabase: null,
    tokenStore,
    rateLimiter: options.rateLimiter ?? createMemoryRateLimiter(10_000),
    idempotencyStore: options.idempotencyStore ?? createMemoryIdempotencyStore(),
  }
  return { deps, readToken, writeToken }
}

const writeAuth = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

// ---------------------------------------------------------------- submit 契约

function makeSubmitPipeline(): { pipeline: V1SubmitPipeline; calls: V1SubmitInput[] } {
  const calls: V1SubmitInput[] = []
  const pipeline: V1SubmitPipeline = async (input) => {
    calls.push(input)
    if (input.sourceUrl.includes('unsupported.example')) {
      throw new V1Error('UNSUPPORTED_SOURCE', `unsupported source url: ${input.sourceUrl}`, {
        sourceUrl: input.sourceUrl,
      })
    }
    if (input.sourceUrl.includes('/notranscript')) {
      throw new V1Error('NO_TRANSCRIPT', 'No subtitle in the video')
    }
    return { jobId: 'job_fixture123', contentId: null, reused: false }
  }
  return { pipeline, calls }
}

test('submit: 未授权（无 Bearer）→ 401 UNAUTHORIZED envelope', async () => {
  const harness = await makeHarnessAsync()
  const { pipeline } = makeSubmitPipeline()
  const { res, recorded } = fakeRes()
  await handleV1Submit(
    fakeReq({ method: 'POST', body: { sourceUrl: 'https://www.youtube.com/watch?v=x' } }),
    res,
    harness.deps,
    pipeline,
  )
  assert.equal(recorded.status, 401)
  assert.equal((recorded.body as { error: { code: string } }).error.code, 'UNAUTHORIZED')
})

test('submit: 错误 token（查无/撤销）→ 401', async () => {
  const harness = await makeHarnessAsync()
  const { pipeline } = makeSubmitPipeline()
  const { res, recorded } = fakeRes()
  await handleV1Submit(
    fakeReq({
      method: 'POST',
      headers: writeAuth('bvt_wrong'),
      body: { sourceUrl: 'https://www.youtube.com/watch?v=x' },
    }),
    res,
    harness.deps,
    pipeline,
  )
  assert.equal(recorded.status, 401)
})

test('submit: read scope 调写端点 → 403 FORBIDDEN', async () => {
  const harness = await makeHarnessAsync()
  const { pipeline } = makeSubmitPipeline()
  const { res, recorded } = fakeRes()
  await handleV1Submit(
    fakeReq({
      method: 'POST',
      headers: writeAuth(harness.readToken),
      body: { sourceUrl: 'https://www.youtube.com/watch?v=x' },
    }),
    res,
    harness.deps,
    pipeline,
  )
  assert.equal(recorded.status, 403)
  assert.equal((recorded.body as { error: { code: string } }).error.code, 'FORBIDDEN')
})

test('submit: 不支持域名 → 422 UNSUPPORTED_SOURCE', async () => {
  const harness = await makeHarnessAsync()
  const { pipeline } = makeSubmitPipeline()
  const { res, recorded } = fakeRes()
  await handleV1Submit(
    fakeReq({
      method: 'POST',
      headers: writeAuth(harness.writeToken),
      body: { sourceUrl: 'https://unsupported.example/watch?v=x' },
    }),
    res,
    harness.deps,
    pipeline,
  )
  assert.equal(recorded.status, 422)
  const body = recorded.body as { error: { code: string; details: { sourceUrl: string } } }
  assert.equal(body.error.code, 'UNSUPPORTED_SOURCE')
  assert.equal(body.error.details.sourceUrl, 'https://unsupported.example/watch?v=x')
})

test('submit: 缺 sourceUrl → 400 INVALID_REQUEST', async () => {
  const harness = await makeHarnessAsync()
  const { pipeline } = makeSubmitPipeline()
  const { res, recorded } = fakeRes()
  await handleV1Submit(
    fakeReq({ method: 'POST', headers: writeAuth(harness.writeToken), body: {} }),
    res,
    harness.deps,
    pipeline,
  )
  assert.equal(recorded.status, 400)
  assert.equal((recorded.body as { error: { code: string } }).error.code, 'INVALID_REQUEST')
})

test('submit: 幂等重复提交 → 同 key 同 body 重放首次 202，管线只跑一次', async () => {
  const harness = await makeHarnessAsync()
  const { pipeline, calls } = makeSubmitPipeline()
  const request = () =>
    fakeReq({
      method: 'POST',
      headers: { ...writeAuth(harness.writeToken), 'idempotency-key': 'k-1' },
      body: { sourceUrl: 'https://www.youtube.com/watch?v=abc' },
    })
  const first = fakeRes()
  await handleV1Submit(request(), first.res, harness.deps, pipeline)
  assert.equal(first.recorded.status, 202)
  assert.deepEqual(first.recorded.body, { jobId: 'job_fixture123', contentId: null, reused: false })

  const replay = fakeRes()
  await handleV1Submit(request(), replay.res, harness.deps, pipeline)
  assert.equal(replay.recorded.status, 202)
  assert.deepEqual(replay.recorded.body, first.recorded.body)
  assert.equal(replay.recorded.headers['idempotency-replayed'], 'true')
  assert.equal(calls.length, 1)
})

test('submit: 同 key 不同 body → 409 IDEMPOTENCY_CONFLICT', async () => {
  const harness = await makeHarnessAsync()
  const { pipeline } = makeSubmitPipeline()
  const headers = { ...writeAuth(harness.writeToken), 'idempotency-key': 'k-2' }
  const first = fakeRes()
  await handleV1Submit(
    fakeReq({ method: 'POST', headers, body: { sourceUrl: 'https://www.youtube.com/watch?v=a' } }),
    first.res,
    harness.deps,
    pipeline,
  )
  assert.equal(first.recorded.status, 202)
  const second = fakeRes()
  await handleV1Submit(
    fakeReq({ method: 'POST', headers, body: { sourceUrl: 'https://www.youtube.com/watch?v=b' } }),
    second.res,
    harness.deps,
    pipeline,
  )
  assert.equal(second.recorded.status, 409)
  assert.equal((second.recorded.body as { error: { code: string } }).error.code, 'IDEMPOTENCY_CONFLICT')
})

test('submit: 无字幕来源 → 501 NO_TRANSCRIPT', async () => {
  const harness = await makeHarnessAsync()
  const { pipeline } = makeSubmitPipeline()
  const { res, recorded } = fakeRes()
  await handleV1Submit(
    fakeReq({
      method: 'POST',
      headers: writeAuth(harness.writeToken),
      body: { sourceUrl: 'https://www.youtube.com/notranscript?v=x' },
    }),
    res,
    harness.deps,
    pipeline,
  )
  assert.equal(recorded.status, 501)
  assert.equal((recorded.body as { error: { code: string } }).error.code, 'NO_TRANSCRIPT')
})

test('submit: 触发限流 → 429 RATE_LIMITED + Retry-After', async () => {
  const harness = await makeHarnessAsync({ rateLimiter: alwaysFailRateLimiter(42) })
  const { pipeline } = makeSubmitPipeline()
  const { res, recorded } = fakeRes()
  await handleV1Submit(
    fakeReq({
      method: 'POST',
      headers: writeAuth(harness.writeToken),
      body: { sourceUrl: 'https://www.youtube.com/watch?v=x' },
    }),
    res,
    harness.deps,
    pipeline,
  )
  assert.equal(recorded.status, 429)
  assert.equal((recorded.body as { error: { code: string } }).error.code, 'RATE_LIMITED')
  assert.equal(recorded.headers['retry-after'], '42')
})

test('submit: GET → 405', async () => {
  const harness = await makeHarnessAsync()
  const { pipeline } = makeSubmitPipeline()
  const { res, recorded } = fakeRes()
  await handleV1Submit(fakeReq({ method: 'GET', headers: writeAuth(harness.writeToken) }), res, harness.deps, pipeline)
  assert.equal(recorded.status, 405)
  assert.ok(recorded.headers['allow'])
})

test('submit: Idempotency-Key 超长 → 400 且不执行管线；200 字符以内不受影响', async () => {
  const harness = await makeHarnessAsync()
  const { pipeline, calls } = makeSubmitPipeline()
  const tooLong = fakeRes()
  await handleV1Submit(
    fakeReq({
      method: 'POST',
      headers: { ...writeAuth(harness.writeToken), 'idempotency-key': 'k'.repeat(201) },
      body: { sourceUrl: 'https://www.youtube.com/watch?v=a' },
    }),
    tooLong.res,
    harness.deps,
    pipeline,
  )
  assert.equal(tooLong.recorded.status, 400)
  assert.equal((tooLong.recorded.body as { error: { code: string } }).error.code, 'INVALID_REQUEST')
  assert.equal(calls.length, 0)

  const atLimit = fakeRes()
  await handleV1Submit(
    fakeReq({
      method: 'POST',
      headers: { ...writeAuth(harness.writeToken), 'idempotency-key': 'k'.repeat(200) },
      body: { sourceUrl: 'https://www.youtube.com/watch?v=a' },
    }),
    atLimit.res,
    harness.deps,
    pipeline,
  )
  assert.equal(atLimit.recorded.status, 202)
})

// ---------------------------------------------------------------- import 契约

function makeImporter(): { importer: V1Importer; calls: Array<{ userId: string; items: unknown[] }> } {
  const calls: Array<{ userId: string; items: unknown[] }> = []
  const importer: V1Importer = async (userId, items) => {
    calls.push({ userId, items })
    const contentIdByDedupeKey: Record<string, string | null> = {}
    for (const item of items) {
      contentIdByDedupeKey[(item as { dedupeKey: string }).dedupeKey] =
        (item as { dedupeKey: string }).dedupeKey === 'youtube:video:dup'
          ? 'cccccccc-0000-0000-0000-000000000009'
          : null
    }
    return { writtenKeys: items.map((item) => (item as { dedupeKey: string }).dedupeKey), contentIdByDedupeKey }
  }
  return { importer, calls }
}

test('import: 正常导入（含请求内去重）→ imported + duplicates，绝不触发摘要管线', async () => {
  const harness = await makeHarnessAsync()
  const { importer, calls } = makeImporter()
  const submit = makeSubmitPipeline()
  const { res, recorded } = fakeRes()
  await handleV1Import(
    fakeReq({
      method: 'POST',
      headers: writeAuth(harness.writeToken),
      body: {
        urls: [
          'https://www.youtube.com/watch?v=one',
          'https://www.bilibili.com/video/BV1xx411c7mD?p=2',
          'https://www.youtube.com/watch?v=one',
        ],
        target: 'watch-later',
      },
    }),
    res,
    harness.deps,
    importer,
  )
  assert.equal(recorded.status, 200)
  const body = recorded.body as {
    imported: Array<{ sourceUrl: string; contentId: string | null; service: string }>
    duplicates: string[]
  }
  assert.equal(body.imported.length, 2)
  assert.deepEqual(body.imported.map((item) => item.service).sort(), ['bilibili', 'youtube'])
  assert.equal(body.imported[0].contentId, null)
  assert.equal(body.duplicates.length, 1)
  assert.equal(body.duplicates[0], 'https://www.youtube.com/watch?v=one')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].items.length, 2)
  // 关键不变量：import 路径结构上没有摘要管线入口
  assert.equal(submit.calls.length, 0)
})

test('import: 含不支持 URL → 422 + details.unsupported，不部分导入', async () => {
  const harness = await makeHarnessAsync()
  const { importer, calls } = makeImporter()
  const { res, recorded } = fakeRes()
  await handleV1Import(
    fakeReq({
      method: 'POST',
      headers: writeAuth(harness.writeToken),
      body: { urls: ['https://www.youtube.com/watch?v=ok', 'https://example.com/video/1'], target: 'watch-later' },
    }),
    res,
    harness.deps,
    importer,
  )
  assert.equal(recorded.status, 422)
  const body = recorded.body as { error: { code: string; details: { unsupported: string[] } } }
  assert.equal(body.error.code, 'UNSUPPORTED_SOURCE')
  assert.deepEqual(body.error.details.unsupported, ['https://example.com/video/1'])
  assert.equal(calls.length, 0)
})

test('import: target 非法 → 400；urls 超 50 → 400', async () => {
  const harness = await makeHarnessAsync()
  const { importer } = makeImporter()
  const badTarget = fakeRes()
  await handleV1Import(
    fakeReq({
      method: 'POST',
      headers: writeAuth(harness.writeToken),
      body: { urls: ['https://www.youtube.com/watch?v=a'], target: 'summary' },
    }),
    badTarget.res,
    harness.deps,
    importer,
  )
  assert.equal(badTarget.recorded.status, 400)

  const tooMany = fakeRes()
  await handleV1Import(
    fakeReq({
      method: 'POST',
      headers: writeAuth(harness.writeToken),
      body: {
        urls: Array.from({ length: 51 }, (_, index) => `https://www.youtube.com/watch?v=v${index}`),
        target: 'watch-later',
      },
    }),
    tooMany.res,
    harness.deps,
    importer,
  )
  assert.equal(tooMany.recorded.status, 400)
})

test('import: read scope → 403；幂等重复导入重放首次结果', async () => {
  const harness = await makeHarnessAsync()
  const { importer } = makeImporter()
  const readScope = fakeRes()
  await handleV1Import(
    fakeReq({
      method: 'POST',
      headers: writeAuth(harness.readToken),
      body: { urls: ['https://www.youtube.com/watch?v=a'], target: 'watch-later' },
    }),
    readScope.res,
    harness.deps,
    importer,
  )
  assert.equal(readScope.recorded.status, 403)

  const request = () =>
    fakeReq({
      method: 'POST',
      headers: { ...writeAuth(harness.writeToken), 'idempotency-key': 'imp-1' },
      body: { urls: ['https://www.youtube.com/watch?v=a'], target: 'watch-later' },
    })
  const first = fakeRes()
  await handleV1Import(request(), first.res, harness.deps, importer)
  assert.equal(first.recorded.status, 200)
  const replay = fakeRes()
  await handleV1Import(request(), replay.res, harness.deps, importer)
  assert.equal(replay.recorded.status, 200)
  assert.deepEqual(replay.recorded.body, first.recorded.body)
  assert.equal(replay.recorded.headers['idempotency-replayed'], 'true')
})

// ---------------------------------------------------------------- job status 契约

function makeJobReader(impl: V1JobReader['get']): V1JobReader {
  return { get: impl }
}

test('jobs: 查询 running job → 200 { jobId, status, error, contentId }，handler 传入 auth.userId', async () => {
  const harness = await makeHarnessAsync()
  const seen: Array<{ jobId: string; userId: string }> = []
  const reader = makeJobReader((jobId, userId) => {
    seen.push({ jobId, userId })
    return Promise.resolve({
      status: 'running',
      error: null,
      videoConfig: { service: 'youtube', videoId: 'abc', pageNumber: null },
    })
  })
  const { res, recorded } = fakeRes()
  await handleV1JobsGet(
    fakeReq({ method: 'GET', headers: writeAuth(harness.writeToken), query: { id: 'job_x' } }),
    res,
    harness.deps,
    reader,
  )
  assert.equal(recorded.status, 200)
  assert.deepEqual(recorded.body, { jobId: 'job_x', status: 'running', error: null, contentId: null })
  assert.deepEqual(seen, [{ jobId: 'job_x', userId: '00000000-0000-0000-0000-000000000001' }])
})

test('jobs: 未知 job → 404 NOT_FOUND；非归属用户 → 404；failed job 透传 JobError', async () => {
  const harness = await makeHarnessAsync()
  const missing = fakeRes()
  await handleV1JobsGet(
    fakeReq({ method: 'GET', headers: writeAuth(harness.writeToken), query: { id: 'job_missing' } }),
    missing.res,
    harness.deps,
    makeJobReader(() => Promise.resolve(null)),
  )
  assert.equal(missing.recorded.status, 404)
  assert.equal((missing.recorded.body as { error: { code: string } }).error.code, 'NOT_FOUND')

  // 归属校验：reader 模拟「该用户未登记访问权」→ null → 404（不泄漏存在性）
  const forbiddenUser = '11111111-0000-0000-0000-000000000009'
  const unauthorized = fakeRes()
  await handleV1JobsGet(
    fakeReq({ method: 'GET', headers: writeAuth(harness.writeToken), query: { id: 'job_of_other_user' } }),
    unauthorized.res,
    harness.deps,
    makeJobReader((_jobId, userId) =>
      userId === forbiddenUser
        ? Promise.resolve({ status: 'failed', error: { code: 'UPSTREAM_TIMEOUT', message: 'secret' } })
        : Promise.resolve(null),
    ),
  )
  assert.equal(unauthorized.recorded.status, 404)

  const failed = fakeRes()
  await handleV1JobsGet(
    fakeReq({ method: 'GET', headers: writeAuth(harness.writeToken), query: { id: 'job_f' } }),
    failed.res,
    harness.deps,
    makeJobReader(() =>
      Promise.resolve({ status: 'failed', error: { code: 'UPSTREAM_TIMEOUT', message: 'provider timeout' } }),
    ),
  )
  assert.equal(failed.recorded.status, 200)
  const body = failed.recorded.body as { status: string; error: { code: string } }
  assert.equal(body.status, 'failed')
  assert.equal(body.error.code, 'UPSTREAM_TIMEOUT')
})

// ---------------------------------------------------------------- result / transcript 契约

test('jobOwnership: 内存兜底下登记后本人可读、他人拒绝（无 Redis 时与 MemoryJobStore 对称）', async () => {
  const { recordJobOwner, isJobAccessible } = await import('../jobOwnership')
  const sourceKey = { service: 'youtube', sourceRef: 'youtube:video:abc', sourcePage: null }
  recordJobOwner('job_owner_fixture', 'user-a')
  assert.equal(await isJobAccessible({ supabase: null, jobId: 'job_owner_fixture', userId: 'user-a', sourceKey }), true)
  assert.equal(
    await isJobAccessible({ supabase: null, jobId: 'job_owner_fixture', userId: 'user-b', sourceKey }),
    false,
  )
  assert.equal(
    await isJobAccessible({ supabase: null, jobId: 'job_never_registered', userId: 'user-a', sourceKey }),
    false,
  )
})

function makeContentReader(overrides: Partial<V1ContentReader> = {}): V1ContentReader {
  return {
    async getContent(contentId, userId) {
      if (contentId === 'cccccccc-0000-0000-0000-000000000001') {
        return { id: contentId, title: 'Fixture Video', sourceUrl: 'https://www.youtube.com/watch?v=abc' }
      }
      return null
    },
    async getLatestSummaryText() {
      return '## 一句话总结\n这是 fixture 摘要'
    },
    async getTranscript() {
      return {
        lang: 'en',
        segments: [
          { start: 0, end: 2.5, text: 'hello world' },
          { start: 2.5, end: 5, text: 'second line', lang: 'en', speaker: 'A', sourceRef: 'youtube:video:abc' },
        ],
      }
    },
    ...overrides,
  }
}

test('contents: 读取摘要结果 → 200 { contentId, title, sourceUrl, summaryText }；默认不带 artifact', async () => {
  const harness = await makeHarnessAsync()
  const reader = makeContentReader()
  const { res, recorded } = fakeRes()
  await handleV1ContentsGet(
    fakeReq({
      method: 'GET',
      headers: writeAuth(harness.writeToken),
      query: { contentId: 'cccccccc-0000-0000-0000-000000000001' },
    }),
    res,
    harness.deps,
    reader,
  )
  assert.equal(recorded.status, 200)
  const body = recorded.body as Record<string, unknown>
  assert.equal(body.contentId, 'cccccccc-0000-0000-0000-000000000001')
  assert.equal(body.title, 'Fixture Video')
  assert.equal(body.summaryText, '## 一句话总结\n这是 fixture 摘要')
  assert.equal('artifact' in body, false)
})

test('contents: ?artifact=1 附带 artifact；未知 contentId → 404', async () => {
  const harness = await makeHarnessAsync()
  const reader = makeContentReader({
    async getArtifact(contentId) {
      return {
        contentId,
        summaryId: null,
        chapterSource: null,
        generatedAt: null,
        chapters: [],
        highlights: [],
        keywords: [],
        outline: [],
        transcript: null,
        transcriptMissingReason: null,
      }
    },
  })
  const withArtifact = fakeRes()
  await handleV1ContentsGet(
    fakeReq({
      method: 'GET',
      headers: writeAuth(harness.writeToken),
      query: { contentId: 'cccccccc-0000-0000-0000-000000000001', artifact: '1' },
    }),
    withArtifact.res,
    harness.deps,
    reader,
  )
  assert.equal(withArtifact.recorded.status, 200)
  const body = withArtifact.recorded.body as { artifact: { contentId: string; chapters: unknown[] } }
  assert.equal(body.artifact.contentId, 'cccccccc-0000-0000-0000-000000000001')
  assert.ok(Array.isArray(body.artifact.chapters))

  const missing = fakeRes()
  await handleV1ContentsGet(
    fakeReq({
      method: 'GET',
      headers: writeAuth(harness.writeToken),
      query: { contentId: 'dddddddd-0000-0000-0000-000000000009' },
    }),
    missing.res,
    harness.deps,
    reader,
  )
  assert.equal(missing.recorded.status, 404)
})

test('transcript: 读取字幕分段 → 200 { lang, segments }，TranscriptSegment 字段锁定', async () => {
  const harness = await makeHarnessAsync()
  const { res, recorded } = fakeRes()
  await handleV1TranscriptGet(
    fakeReq({
      method: 'GET',
      headers: writeAuth(harness.writeToken),
      query: { contentId: 'cccccccc-0000-0000-0000-000000000001' },
    }),
    res,
    harness.deps,
    makeContentReader(),
  )
  assert.equal(recorded.status, 200)
  const body = recorded.body as {
    lang: string | null
    segments: Array<{ start: number; end: number; text: string; lang?: string; speaker?: string; sourceRef?: string }>
  }
  assert.equal(body.lang, 'en')
  assert.equal(body.segments.length, 2)
  assert.deepEqual([body.segments[0].start, body.segments[0].end, body.segments[0].text], [0, 2.5, 'hello world'])
  assert.equal(body.segments[1].sourceRef, 'youtube:video:abc')
})

// ---------------------------------------------------------------- watch-later 契约

function makeWatchLaterReader(recordedOptions: Array<{ cursor: unknown; limit: number }>): V1WatchLaterReader {
  return {
    async list(userId, options) {
      recordedOptions.push(options)
      return {
        items: [
          {
            id: 'iiiiiiii-0000-0000-0000-000000000001',
            sourceUrl: 'https://www.youtube.com/watch?v=abc',
            service: 'youtube',
            title: null,
            status: 'pending',
            position: 0,
            contentId: null,
            jobId: null,
            errorCode: null,
            errorMessage: null,
            addedAt: '2026-09-27T00:00:00+00:00',
            finishedAt: null,
          },
        ],
        nextCursor:
          options.cursor === null
            ? { addedAt: '2026-09-27T00:00:00+00:00', position: 0, id: 'iiiiiiii-0000-0000-0000-000000000001' }
            : null,
        collection: { id: 'coll-1', title: '稍后再看', batchStatus: 'idle' },
      }
    },
  }
}

test('watch-later: 列表 + cursor 分页字段；默认 limit=50；坏 cursor → 400', async () => {
  const harness = await makeHarnessAsync()
  const recordedOptions: Array<{ cursor: unknown; limit: number }> = []
  const reader = makeWatchLaterReader(recordedOptions)
  const first = fakeRes()
  await handleV1WatchLaterList(
    fakeReq({ method: 'GET', headers: writeAuth(harness.writeToken) }),
    first.res,
    harness.deps,
    reader,
  )
  assert.equal(first.recorded.status, 200)
  const body = first.recorded.body as { items: unknown[]; cursor?: string; collection: { title: string } }
  assert.equal(body.items.length, 1)
  assert.equal(body.collection.title, '稍后再看')
  assert.equal(typeof body.cursor, 'string')
  // cursor 三分量（addedAt/position/id）：同 added_at 批次 position 重置时靠 id 保全序
  const decodedCursor = JSON.parse(Buffer.from(String(body.cursor), 'base64url').toString()) as Record<string, unknown>
  assert.equal(decodedCursor.addedAt, '2026-09-27T00:00:00+00:00')
  assert.equal(decodedCursor.position, 0)
  assert.equal(decodedCursor.id, 'iiiiiiii-0000-0000-0000-000000000001')
  assert.equal(recordedOptions[0].limit, 50)
  assert.equal(recordedOptions[0].cursor, null)

  const second = fakeRes()
  await handleV1WatchLaterList(
    fakeReq({ method: 'GET', headers: writeAuth(harness.writeToken), query: { cursor: String(body.cursor) } }),
    second.res,
    harness.deps,
    reader,
  )
  const secondBody = second.recorded.body as { cursor?: string }
  assert.equal('cursor' in secondBody, false)

  const bad = fakeRes()
  await handleV1WatchLaterList(
    fakeReq({ method: 'GET', headers: writeAuth(harness.writeToken), query: { cursor: 'not-a-cursor' } }),
    bad.res,
    harness.deps,
    reader,
  )
  assert.equal(bad.recorded.status, 400)
})

// ---------------------------------------------------------------- admin tokens 契约

function withAdminEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.BIBI_V1_ADMIN_TOKEN
  if (value === undefined) {
    delete process.env.BIBI_V1_ADMIN_TOKEN
  } else {
    process.env.BIBI_V1_ADMIN_TOKEN = value
  }
  return fn().finally(() => {
    if (previous === undefined) {
      delete process.env.BIBI_V1_ADMIN_TOKEN
    } else {
      process.env.BIBI_V1_ADMIN_TOKEN = previous
    }
  })
}

test('admin: 未配置 BIBI_V1_ADMIN_TOKEN → 403（管理面禁用）；错 token → 401', async () => {
  const harness = await makeHarnessAsync()
  await withAdminEnv(undefined, async () => {
    const disabled = fakeRes()
    await handleV1AdminTokens(
      fakeReq({ method: 'POST', body: { scope: 'write', userId: '00000000-0000-0000-0000-000000000001' } }),
      disabled.res,
      harness.deps,
    )
    assert.equal(disabled.recorded.status, 403)
    assert.equal((disabled.recorded.body as { error: { code: string } }).error.code, 'FORBIDDEN')
  })
  await withAdminEnv('admin-secret', async () => {
    const wrong = fakeRes()
    await handleV1AdminTokens(
      fakeReq({
        method: 'POST',
        headers: { 'x-admin-token': 'nope' },
        body: { scope: 'write', userId: '00000000-0000-0000-0000-000000000001' },
      }),
      wrong.res,
      harness.deps,
    )
    assert.equal(wrong.recorded.status, 401)
  })
})

test('admin: 新建/列出/撤销 token 全链路', async () => {
  const harness = await makeHarnessAsync()
  await withAdminEnv('admin-secret', async () => {
    const created = fakeRes()
    await handleV1AdminTokens(
      fakeReq({
        method: 'POST',
        headers: { 'x-admin-token': 'admin-secret' },
        body: { scope: 'write', userId: '00000000-0000-0000-0000-000000000001', name: 'extension' },
      }),
      created.res,
      harness.deps,
    )
    assert.equal(created.recorded.status, 201)
    const body = created.recorded.body as { token: string; tokenId: string; scope: string }
    assert.ok(body.token.startsWith('bvt_'))
    assert.equal(body.scope, 'write')

    const list = fakeRes()
    await handleV1AdminTokens(
      fakeReq({ method: 'GET', headers: { 'x-admin-token': 'admin-secret' } }),
      list.res,
      harness.deps,
    )
    assert.equal(list.recorded.status, 200)
    const listBody = list.recorded.body as { tokens: Array<{ tokenId: string; tokenHash?: string }> }
    assert.equal(listBody.tokens.length, 3)
    assert.ok(listBody.tokens.some((token) => token.tokenId === body.tokenId))
    assert.ok(listBody.tokens.every((token) => !('tokenHash' in token) && !('token' in token)))

    const revoked = fakeRes()
    await handleV1AdminTokenRevoke(
      fakeReq({ method: 'DELETE', headers: { 'x-admin-token': 'admin-secret' }, query: { tokenId: body.tokenId } }),
      revoked.res,
      harness.deps,
    )
    assert.equal(revoked.recorded.status, 200)
    assert.deepEqual(revoked.recorded.body, { tokenId: body.tokenId, revoked: true })

    const missing = fakeRes()
    await handleV1AdminTokenRevoke(
      fakeReq({
        method: 'DELETE',
        headers: { 'x-admin-token': 'admin-secret' },
        query: { tokenId: 'ffffffff-0000-0000-0000-000000000009' },
      }),
      missing.res,
      harness.deps,
    )
    assert.equal(missing.recorded.status, 404)

    // 撤销后的 token 调业务端点 → 401
    const afterRevoke = fakeRes()
    await handleV1Submit(
      fakeReq({
        method: 'POST',
        headers: writeAuth(body.token),
        body: { sourceUrl: 'https://www.youtube.com/watch?v=x' },
      }),
      afterRevoke.res,
      harness.deps,
      makeSubmitPipeline().pipeline,
    )
    assert.equal(afterRevoke.recorded.status, 401)
  })
})

test('admin: 缺 userId 且无默认 env → 400', async () => {
  const harness = await makeHarnessAsync()
  await withAdminEnv('admin-secret', async () => {
    const previous = process.env.BIBI_API_DEFAULT_USER_ID
    delete process.env.BIBI_API_DEFAULT_USER_ID
    try {
      const res = fakeRes()
      await handleV1AdminTokens(
        fakeReq({ method: 'POST', headers: { 'x-admin-token': 'admin-secret' }, body: { scope: 'read' } }),
        res.res,
        harness.deps,
      )
      assert.equal(res.recorded.status, 400)
    } finally {
      if (previous !== undefined) {
        process.env.BIBI_API_DEFAULT_USER_ID = previous
      }
    }
  })
})

// ---------------------------------------------------------------- openapi 契约

test('openapi: 覆盖 submit/status/result/import 四端点与统一错误 schema', () => {
  const paths = Object.keys(v1OpenApiSpec.paths)
  for (const required of [
    '/submit',
    '/import',
    '/jobs/{id}',
    '/contents/{contentId}',
    '/contents/{contentId}/transcript',
    '/watch-later',
  ]) {
    assert.ok(paths.includes(required), `openapi paths missing ${required}`)
  }
  const errorCodes = v1OpenApiSpec.components.schemas.ErrorEnvelope.properties.error.properties.code.enum
  for (const code of ['UNAUTHORIZED', 'UNSUPPORTED_SOURCE', 'IDEMPOTENCY_CONFLICT', 'RATE_LIMITED', 'NO_TRANSCRIPT']) {
    assert.ok((errorCodes as readonly string[]).includes(code), `error enum missing ${code}`)
  }
})
