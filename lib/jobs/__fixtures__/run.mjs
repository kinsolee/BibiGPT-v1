// KIN-39 切分+job 管线 fixture：
//   node --import ./lib/jobs/__fixtures__/register.mjs ./lib/jobs/__fixtures__/run.mjs
// 覆盖：确定性切分（无内容丢失/固定 hash）、chunk/reduce 提示词、引擎状态机、
// 并发上限、重试、超时、取消、重启续传（checkpoint）、幂等复用、错误页拦截、失败队列清理。
import { createHash } from 'node:crypto'

import {
  chunkSubtitles,
  DEFAULT_CHUNK_BYTE_LIMIT,
  getUtf8ByteLength,
  limitTranscriptByteLength,
} from '../../openai/getSmallSizeTranscripts.ts'
import { JobEngine, JobFailureError } from '../engine.ts'
import { MemoryJobStore } from '../store.ts'
import { isLikelyHtmlErrorPage, isValidSummaryText } from '../validation.ts'
import { buildChunkUserPrompt, buildReduceUserPrompt } from '../prompts.ts'
import { buildSummaryJobDigest } from '../summaryJob.ts'
import { jobErrorToHttpStatus } from '../errors.ts'
import { TIMESTAMP_CHUNK_BYTE_LIMIT } from '../../openai/getSmallSizeTranscripts.ts'
import { writeJobResultToCanonicalCache } from '../summaryJob.ts'

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

async function expectJobFailure(promiseFactory, expectedCode, label) {
  try {
    await promiseFactory()
    assert(false, label, 'expected job failure but resolved')
  } catch (error) {
    assert(error instanceof JobFailureError, label, `got ${error?.constructor?.name}: ${error?.message}`)
    if (expectedCode) {
      assert(error.code === expectedCode, label, `expected code ${expectedCode}, got ${error.code}`)
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------- 合成字幕 ----------
function syntheticItems(count, options = {}) {
  const { prefix = '段落', bytesPerItem = 120, withSeconds = true, seed = 1 } = options
  const items = []
  let state = seed
  const rand = () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  for (let i = 0; i < count; i++) {
    let text = `${prefix}${i}:`
    while (getUtf8ByteLength(text) < bytesPerItem) {
      text += rand() < 0.5 ? '视频内容要点讲解' : 'abc def ghijk '
    }
    items.push({ text, index: i, s: withSeconds ? i * 12.5 : undefined })
  }
  return items
}

// ---------- 1. 切分：确定性 + 完整性 ----------
{
  const items = syntheticItems(120) // ~14KB+ 文本，必然多 chunk
  const run1 = chunkSubtitles(items)
  const run2 = chunkSubtitles(items.slice().reverse()) // 乱序输入，结果必须一致

  assert(run1.length > 1, 'chunk: 长文本切出多个 chunk', `got ${run1.length}`)
  assert(JSON.stringify(run1) === JSON.stringify(run2), 'chunk: 结果与输入顺序无关（确定性）')
  assert(
    run1.every((chunk) => chunk.byteLength <= DEFAULT_CHUNK_BYTE_LIMIT),
    'chunk: 每个 chunk 不超字节预算',
    run1.map((c) => c.byteLength).join(','),
  )
  assert(
    run1.every((chunk, i) => chunk.index === i),
    'chunk: index 连续递增',
  )
  assert(
    run1.every((chunk) => chunk.hash === createHash('sha256').update(chunk.text, 'utf8').digest('hex').slice(0, 16)),
    'chunk: hash 为文本 sha256 前 16 位（固定）',
  )

  // 无内容丢失：全部 items 文本依序出现在 chunk 文本流中
  const stream = run1.map((c) => c.text).join(' ')
  const joined = items.map((i) => i.text).join(' ')
  assert(stream === joined, 'chunk: 全量内容按序进入 chunk，零丢弃')

  // 时间轴元数据
  assert(run1[0].startSeconds === 0 && run1[0].endSeconds !== null, 'chunk: start/end 秒数回填')

  // 空文本 items 过滤、单 chunk 短文本与旧 join 行为一致
  const short = [
    { text: '短句一', index: 0 },
    { text: '短句二', index: 1 },
  ]
  const single = chunkSubtitles(short)
  assert(single.length === 1 && single[0].text === '短句一 短句二', 'chunk: 短文本单 chunk 且与旧 join 一致')
  assert(chunkSubtitles([]).length === 0, 'chunk: 空输入返回空数组')
  assert(
    chunkSubtitles([
      { text: '', index: 0 },
      { text: 'x', index: 1 },
    ]).length === 1,
    'chunk: 空文本 item 过滤',
  )

  // limitTranscriptByteLength 兼容导出（prompt.ts 仍在用）
  assert(limitTranscriptByteLength('a'.repeat(10), 5).length === 5, 'limit: 旧函数保留且截断')
}

// ---------- 2. 超大单条硬切分 ----------
{
  const bigText = '超'.repeat(5000) // 15000 bytes > 6000
  const chunks = chunkSubtitles([{ text: bigText, index: 0, s: 3 }])
  assert(chunks.length >= 3, 'oversize: 超大单条切成多段', `got ${chunks.length}`)
  assert(
    chunks.every((c) => c.byteLength <= DEFAULT_CHUNK_BYTE_LIMIT),
    'oversize: 每段不超预算',
  )
  assert(chunks.map((c) => c.text).join('') === bigText, 'oversize: 硬切分零丢失')
  assert(chunks[0].startSeconds === 3, 'oversize: 时间戳继承')
  const again = chunkSubtitles([{ text: bigText, index: 0, s: 3 }])
  assert(JSON.stringify(chunks) === JSON.stringify(again), 'oversize: 确定性可重复')
}

// ---------- 3. 提示词 ----------
{
  const chunks = chunkSubtitles(syntheticItems(60, { bytesPerItem: 200 }))
  const videoConfig = { videoId: 'BV1test', sentenceNumber: 7, showEmoji: true, outputLanguage: 'zh' }
  const chunkPrompt = buildChunkUserPrompt({
    title: '测试长视频',
    chunk: chunks[0],
    totalChunks: chunks.length,
    videoConfig,
  })
  assert(chunkPrompt.includes('第 1/') && chunkPrompt.includes('测试长视频'), 'prompt: chunk 提示词带分段标注')
  assert(!chunkPrompt.includes('undefined'), 'prompt: chunk 提示词无 undefined 泄漏')

  const reducePrompt = buildReduceUserPrompt({
    title: '测试长视频',
    chunks,
    chunkOutputs: chunks.map((c) => `- ${c.startSeconds ?? 0} - 段落摘要 ${c.index}`),
    videoConfig,
    shouldShowTimestamp: true,
  })
  assert(reducePrompt.includes('## Chapters'), 'prompt: reduce 模板含 Chapters')
  assert(reducePrompt.includes(`Section 1/${chunks.length}`), 'prompt: reduce 依序列出各段摘要')
  assert(!reducePrompt.includes('undefined'), 'prompt: reduce 提示词无 undefined 泄漏')
}

// ---------- 引擎测试脚手架 ----------
function buildParams(items, { concurrency = 2, byteLimit = DEFAULT_CHUNK_BYTE_LIMIT } = {}) {
  const chunks = chunkSubtitles(items, byteLimit).map(
    ({ index, hash, text, byteLength, startSeconds, endSeconds }) => ({
      index,
      hash,
      text,
      byteLength,
      startSeconds,
      endSeconds,
    }),
  )
  return {
    videoConfig: { videoId: 'BV1engine', sentenceNumber: 7 },
    userConfig: {},
    title: '引擎测试',
    chunks,
    model: 'gpt-4o-mini',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    promptVersion: 'summary-v2',
    detailTokens: 600,
    apiKey: 'sk-test',
  }
}

function recordingRunner(options = {}) {
  const state = {
    chunkCalls: [],
    reduceCalls: [],
    inFlight: 0,
    maxInFlight: 0,
    failChunkIndexes: new Set(options.failChunkIndexes ?? []),
    failTimes: options.failTimes ?? 1, // 每个失败 chunk 连续失败次数
    failureCounts: new Map(),
    chunkDelayMs: options.chunkDelayMs ?? 0,
    timeoutMs: options.timeoutMs ?? 0, // >0 时 chunk 永远睡过超时
    reduceDelayMs: options.reduceDelayMs ?? 0,
    hang: options.hang ?? false, // true 时 chunk 返回永不 settle 的 promise
  }
  const runner = {
    state,
    async runChunk(params, chunkIndex) {
      state.chunkCalls.push(chunkIndex)
      state.inFlight += 1
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
      try {
        if (state.hang) {
          return await new Promise(() => {})
        }
        if (state.timeoutMs > 0) {
          await sleep(state.timeoutMs)
          return '不应到达'
        }
        if (state.chunkDelayMs > 0) {
          await sleep(state.chunkDelayMs)
        }
        if (state.failChunkIndexes.has(chunkIndex)) {
          const seen = (state.failureCounts.get(chunkIndex) ?? 0) + 1
          state.failureCounts.set(chunkIndex, seen)
          if (seen <= state.failTimes) {
            throw new Error('mock provider 500: internal server error')
          }
        }
        return `【第${chunkIndex + 1}段摘要】要点一二三`
      } finally {
        state.inFlight -= 1
      }
    },
    async runReduce(params, chunkOutputs) {
      state.reduceCalls.push(chunkOutputs.length)
      if (state.reduceDelayMs > 0) {
        await sleep(state.reduceDelayMs)
      }
      if (options.reduceThrows) {
        throw new Error(options.reduceThrows)
      }
      return `## Summary\n全局结论\n## Highlights\n${chunkOutputs.join('\n')}\n## Chapters\n- 0:00 开头`
    },
  }
  return runner
}

function makeEngine(store, runner, overrides = {}) {
  return new JobEngine({
    store,
    runner,
    concurrency: 2,
    stepTimeoutMs: 5_000,
    stepMaxAttempts: 2,
    stepBackoffMs: 1,
    ...overrides,
  })
}

// ---------- 4. happy path：多 chunk 并行 + reduce 合并 ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner()
  const engine = makeEngine(store, runner)
  const params = buildParams(syntheticItems(40, { bytesPerItem: 300 }))

  const { snapshot, reused } = await engine.runSummaryJob(params, 'digest_happy')
  assert(!reused, 'happy: 首次运行非复用')
  assert(snapshot.record.status === 'succeeded', 'happy: job succeeded')
  assert(snapshot.record.resultText.includes('## Chapters'), 'happy: reduce 输出为最终全文')
  assert(runner.state.chunkCalls.length === params.chunks.length, 'happy: 每个 chunk 恰好调用一次')
  assert(runner.state.reduceCalls[0] === params.chunks.length, 'happy: reduce 收到全部 chunk 输出')
  assert(runner.state.maxInFlight <= 2, 'happy: 并发不超上限', `max=${runner.state.maxInFlight}`)
  assert(snapshot.record.checkpoint.length === params.chunks.length, 'happy: checkpoint 覆盖全部 chunk')
  const storeActive = await store.listActiveJobIds()
  assert(storeActive.length === 0, 'happy: 成功后移出 active 索引')

  // 幂等复用：同 digest 再跑，直接返回，不再调 provider
  const chunkCallsBefore = runner.state.chunkCalls.length
  const again = await engine.runSummaryJob(params, 'digest_happy')
  assert(again.reused === true, 'happy: 二次运行 reused=true')
  assert(runner.state.chunkCalls.length === chunkCallsBefore, 'happy: 复用时零 provider 调用')
  assert(again.snapshot.record.resultText === snapshot.record.resultText, 'happy: 复用结果一致')

  // 配置变化 → digest 变化 → 新 job
  const d1 = buildSummaryJobDigest({ ...params, chunks: params.chunks })
  const d2 = buildSummaryJobDigest({ ...params, videoConfig: { ...params.videoConfig, sentenceNumber: 9 } })
  const d3 = buildSummaryJobDigest({ ...params, chunks: [{ ...params.chunks[0], text: 'changed', hash: 'deadbeef' }] })
  assert(d1 === buildSummaryJobDigest({ ...params }), 'digest: 同输入同 digest')
  assert(d1 !== d2, 'digest: 配置变化 digest 变化')
  assert(d1 !== d3, 'digest: chunk hash 变化 digest 变化')
  assert(/^[0-9a-f]{32}$/.test(d1), 'digest: 32 位 hex')
}

// ---------- 5. 重试后成功：attempt 记录 + 上游分类 ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner({ failChunkIndexes: new Set([1]), failTimes: 1 })
  const engine = makeEngine(store, runner)
  const params = buildParams(syntheticItems(30, { bytesPerItem: 300 }))

  const { snapshot } = await engine.runSummaryJob(params, 'digest_retry')
  assert(snapshot.record.status === 'succeeded', 'retry: 重试后成功')
  const failedThenSucceededStep = snapshot.steps.find((s) => s.chunkIndex === 1)
  assert(failedThenSucceededStep.attempt === 2, 'retry: attempt 记录为 2')
  assert(failedThenSucceededStep.status === 'succeeded', 'retry: 最终 succeeded')
  assert(
    snapshot.steps.every((s) => s.error === null || s.status === 'succeeded'),
    'retry: 成功后 error 清空',
  )
}

// ---------- 6. 非重试型错误：立即失败不消耗 attempt ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner()
  // 模拟 401/模型不存在：直接抛非重试错误
  runner.runChunk = async (params, chunkIndex) => {
    if (chunkIndex === 0) {
      const error = new Error('invalid api key')
      error.statusCode = 401
      throw error
    }
    return 'ok'
  }
  const engine = makeEngine(store, runner, { concurrency: 1 })
  const params = buildParams(syntheticItems(10, { bytesPerItem: 300 }))

  await expectJobFailure(
    () => engine.runSummaryJob(params, 'digest_auth'),
    'UPSTREAM_AUTH',
    'noretry: job 失败抛 JobFailureError',
  )
  const record = await store.loadJob('job_digest_auth')
  assert(record.status === 'failed', 'noretry: job 状态 failed')
  assert(record.error.code === 'UPSTREAM_AUTH', 'noretry: 记录 error code')
  const step0 = (await store.loadSteps('job_digest_auth')).find((s) => s.chunkIndex === 0)
  assert(step0.attempt === 1 && step0.status === 'failed', 'noretry: 非重试错误只跑一次 attempt')
  const failedIds = await store.listFailedJobIds()
  assert(failedIds.includes('job_digest_auth'), 'noretry: 进入失败队列索引')
}

// ---------- 7. 超时：重试耗尽 → TIMEOUT，checkpoint 保留成功 chunk ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner({ timeoutMs: 120 })
  const engine = makeEngine(store, runner, { stepTimeoutMs: 20, stepMaxAttempts: 2, concurrency: 1 })
  const params = buildParams(syntheticItems(10, { bytesPerItem: 300 }))

  await expectJobFailure(() => engine.runSummaryJob(params, 'digest_timeout'), 'TIMEOUT', 'timeout: 超时失败')
  const record = await store.loadJob('job_digest_timeout')
  assert(record.status === 'failed' && record.error.code === 'TIMEOUT', 'timeout: 记录 TIMEOUT')
}

// ---------- 8. 重启续传：成功 chunk 不重跑 ----------
{
  const store = new MemoryJobStore()
  const failingRunner = recordingRunner({ failChunkIndexes: new Set([1]) })
  // failTimes 大于 maxAttempts，第一轮必然失败
  failingRunner.state.failTimes = 99
  const engine1 = makeEngine(store, failingRunner, { concurrency: 1 })
  const params = buildParams(syntheticItems(30, { bytesPerItem: 300 }))

  await expectJobFailure(() => engine1.runSummaryJob(params, 'digest_resume'), null, 'resume: 第一轮失败')
  const midRecord = await store.loadJob('job_digest_resume')
  assert(midRecord.attempt === 1, 'resume: attempt=1')
  assert(
    midRecord.checkpoint.length === params.chunks.length - 1,
    'resume: 失败前 checkpoint 保留成功 chunk',
    JSON.stringify(midRecord.checkpoint),
  )

  // 模拟进程重启：新 engine 实例共享同一 store；runner 恢复正常
  const okRunner = recordingRunner()
  const engine2 = makeEngine(store, okRunner, { concurrency: 1 })
  const { snapshot } = await engine2.runSummaryJob(params, 'digest_resume')

  assert(snapshot.record.status === 'succeeded', 'resume: 续传后成功')
  assert(snapshot.record.attempt === 2, 'resume: attempt 递增为 2')
  // 只重跑了失败的那个 chunk + reduce
  assert(
    JSON.stringify(okRunner.state.chunkCalls) === JSON.stringify([1]),
    'resume: 仅重跑失败 chunk',
    JSON.stringify(okRunner.state.chunkCalls),
  )
}

// ---------- 9. 取消：queued 直接终态；running 在间隙停下 ----------
{
  const store = new MemoryJobStore()
  const slowRunner = recordingRunner({ chunkDelayMs: 60 })
  const engine = makeEngine(store, slowRunner, { concurrency: 1 })
  const params = buildParams(syntheticItems(30, { bytesPerItem: 300 }))

  const running = engine.runSummaryJob(params, 'digest_cancel')
  await sleep(20) // 第一个 chunk 进行中
  assert(await engine.cancel('job_digest_cancel'), 'cancel: running job 可取消')
  await expectJobFailure(() => running, 'CANCELED', 'cancel: 请求以 CANCELED 失败')
  const record = await store.loadJob('job_digest_cancel')
  assert(record.status === 'canceled', 'cancel: 状态 canceled')
  assert((await engine.cancel('job_digest_cancel')) === true, 'cancel: 二次取消幂等返回 true')

  // 不存在的 job
  assert((await engine.cancel('job_nope')) === false, 'cancel: 未知 job 返回 false')
}

// ---------- 10. provider 错误页拦截 ----------
{
  assert(isLikelyHtmlErrorPage('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>'), 'html: doctype 错误页')
  assert(isLikelyHtmlErrorPage('<html>Service Unavailable'), 'html: 无 doctype 错误页')
  assert(!isLikelyHtmlErrorPage('## Summary\n正常摘要 <重要> 内容'), 'html: 正常摘要不误伤')
  assert(!isLikelyHtmlErrorPage(''), 'html: 空文本不是错误页')
  assert(!isValidSummaryText('   '), 'valid: 空白文本无效')

  const store = new MemoryJobStore()
  const runner = recordingRunner()
  runner.runChunk = async () => '<html><body><h1>502 Bad Gateway</h1>nginx</body></html>'
  const engine = makeEngine(store, runner)
  const params = buildParams(syntheticItems(10, { bytesPerItem: 300 }))

  await expectJobFailure(
    () => engine.runSummaryJob(params, 'digest_html'),
    'PROVIDER_ERROR_PAGE',
    'html: 错误页导致 job 失败',
  )
  const record = await store.loadJob('job_digest_html')
  assert(record.error.code === 'PROVIDER_ERROR_PAGE', 'html: 记录 PROVIDER_ERROR_PAGE')
}

// ---------- 11. reduce 失败 → job failed（chunk 全部保留可续传） ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner({ reduceThrows: 'mock provider overloaded: service unavailable' })
  const engine = makeEngine(store, runner)
  const params = buildParams(syntheticItems(10, { bytesPerItem: 300 }))

  await expectJobFailure(() => engine.runSummaryJob(params, 'digest_reduce_fail'), 'UPSTREAM_5XX', 'reduce: 失败抛错')
  const record = await store.loadJob('job_digest_reduce_fail')
  assert(record.status === 'failed', 'reduce: job failed')
  assert(record.checkpoint.length === params.chunks.length, 'reduce: 全部 chunk 仍成功（可续传只重跑 reduce）')
}

// ---------- 12. 失败队列清理 ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner({ failChunkIndexes: new Set([0]) })
  runner.state.failTimes = 99
  const engine = makeEngine(store, runner)
  const params = buildParams(syntheticItems(5, { bytesPerItem: 300 }))
  await expectJobFailure(() => engine.runSummaryJob(params, 'digest_cleanup'), null, 'cleanup: 先制造失败')
  assert((await store.listFailedJobIds()).includes('job_digest_cleanup'), 'cleanup: 在失败队列')

  const removed = await engine.cleanupFailedJobs()
  assert(removed >= 1, 'cleanup: 清理数量 >=1', String(removed))
  assert((await store.loadJob('job_digest_cleanup')) === null, 'cleanup: 记录已删除')
  assert((await store.listFailedJobIds()).length === 0, 'cleanup: 索引已清空')
}

// ---------- 13. 错误码 → HTTP 映射 ----------
{
  assert(jobErrorToHttpStatus('TIMEOUT') === 504, 'http: TIMEOUT→504')
  assert(jobErrorToHttpStatus('CANCELED') === 499, 'http: CANCELED→499')
  assert(jobErrorToHttpStatus('RATE_LIMITED') === 429, 'http: RATE_LIMITED→429')
  assert(jobErrorToHttpStatus('PROVIDER_ERROR_PAGE') === 502, 'http: 错误页→502')
  assert(jobErrorToHttpStatus('JOB_LOCK_BUSY') === 409, 'http: 锁忙→409')
  assert(jobErrorToHttpStatus('WHATEVER_NEW_CODE') === 502, 'http: 未知码默认 502')
}

// ---------- 14. apiKey 绝不持久化进 job record ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner()
  const engine = makeEngine(store, runner)
  const params = buildParams(syntheticItems(10, { bytesPerItem: 300 }))

  await engine.runSummaryJob(params, 'digest_nokey')
  const record = await store.loadJob('job_digest_nokey')
  assert(record.status === 'succeeded', 'nokey: job 正常完成')
  assert(record.params.apiKey === '', 'nokey: 持久化 params 中 apiKey 为空串')
  assert(!JSON.stringify(record).includes('sk-test'), 'nokey: 序列化记录不含明文 key')
}

// ---------- 15. forceNewResult 清空已完成步骤后全量重跑 ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner()
  const engine = makeEngine(store, runner)
  const params = buildParams(syntheticItems(10, { bytesPerItem: 300 }))

  await engine.runSummaryJob(params, 'digest_force')
  const callsAfterFirst = runner.state.chunkCalls.length
  const reducesAfterFirst = runner.state.reduceCalls.length
  assert(callsAfterFirst > 0 && reducesAfterFirst === 1, 'force: 首轮正常执行')

  const { snapshot, reused } = await engine.runSummaryJob(params, 'digest_force', { forceNewResult: true })
  assert(reused === false, 'force: 重跑非复用')
  assert(snapshot.record.status === 'succeeded' && snapshot.record.resultText, 'force: 重跑成功')
  assert(runner.state.chunkCalls.length === callsAfterFirst * 2, 'force: 全部 chunk 重新调用')
  assert(runner.state.reduceCalls.length === reducesAfterFirst + 1, 'force: reduce 重新调用')
  assert(snapshot.record.attempt === 2, 'force: attempt 递增')
}

// ---------- 16. reduce 进行中取消：不被 succeeded 覆盖 ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner({ reduceDelayMs: 120 })
  const engine = makeEngine(store, runner, { concurrency: 2 })
  const params = buildParams(syntheticItems(10, { bytesPerItem: 300 }))

  const running = engine.runSummaryJob(params, 'digest_cancel_reduce')
  await sleep(60) // map 已完成，reduce 进行中
  assert(await engine.cancel('job_digest_cancel_reduce'), 'cancel-reduce: 取消请求成功')
  await expectJobFailure(() => running, 'CANCELED', 'cancel-reduce: 以 CANCELED 结束')
  const record = await store.loadJob('job_digest_cancel_reduce')
  assert(record.status === 'canceled', 'cancel-reduce: 终态 canceled 而非 succeeded', record.status)
  assert(record.resultText === null, 'cancel-reduce: 不写入结果')
}

// ---------- 17. 超时重试不突破并发上限（等孤儿 attempt settle 后再重试） ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner({ timeoutMs: 25 }) // 孤子会在 2×stepTimeout 内 settle
  const engine = makeEngine(store, runner, { stepTimeoutMs: 15, stepMaxAttempts: 2, concurrency: 1 })
  const params = buildParams(syntheticItems(20, { bytesPerItem: 300 })) // 2 chunks

  await expectJobFailure(() => engine.runSummaryJob(params, 'digest_orphan'), 'TIMEOUT', 'orphan: 超时失败')
  assert(runner.state.maxInFlight <= 1, 'orphan: 重试等待孤儿结束，并发不超上限', `max=${runner.state.maxInFlight}`)
}

// ---------- 18. 跨实例执行锁 ----------
{
  // store 层语义
  const lockStore = new MemoryJobStore()
  assert((await lockStore.acquireJobLock('a', 'h1', 60_000)) === true, 'lock: 首次获取')
  assert((await lockStore.acquireJobLock('a', 'h2', 60_000)) === false, 'lock: 他人持有被拒')
  assert((await lockStore.acquireJobLock('a', 'h1', 60_000)) === true, 'lock: 持有者可重入刷新')
  await lockStore.releaseJobLock('a', 'h2') // 非持有者 no-op
  assert((await lockStore.acquireJobLock('a', 'h2', 60_000)) === false, 'lock: 非持有者释放无效')
  await lockStore.releaseJobLock('a', 'h1')
  assert((await lockStore.acquireJobLock('a', 'h2', 60_000)) === true, 'lock: 释放后他人可获取')
  assert((await lockStore.acquireJobLock('b', 'h1', 1)) === true, 'lock: TTL 用例获取')
  await sleep(10)
  assert((await lockStore.acquireJobLock('b', 'h2', 60_000)) === true, 'lock: TTL 过期自动失效')

  // engine 层：两个 engine 实例（模拟两实例部署）并发同一 digest
  const store = new MemoryJobStore()
  const slowRunner = recordingRunner({ chunkDelayMs: 100 })
  const engineA = makeEngine(store, slowRunner, { lockWaitMs: 10_000 })
  const busyRunner = recordingRunner()
  const engineB = makeEngine(store, busyRunner, { lockWaitMs: 60, lockRetryIntervalMs: 15 })
  const params = buildParams(syntheticItems(10, { bytesPerItem: 300 }))

  const first = engineA.runSummaryJob(params, 'digest_lock')
  await sleep(20) // A 已持锁进入执行
  await expectJobFailure(() => engineB.runSummaryJob(params, 'digest_lock'), 'JOB_LOCK_BUSY', 'lock: B 拿不到锁报 busy')
  const a = await first
  assert(a.snapshot.record.status === 'succeeded', 'lock: A 正常完成')

  // A 完成释放锁后 B 再来：直接复用
  const b = await engineB.runSummaryJob(params, 'digest_lock')
  assert(b.reused === true && busyRunner.state.chunkCalls.length === 0, 'lock: A 完成后 B 复用结果')
}

// ---------- 19. userConfig.userKey 不落库（嵌套凭据同样剥离） ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner()
  const engine = makeEngine(store, runner)
  const params = buildParams(syntheticItems(10, { bytesPerItem: 300 }))
  params.userConfig = { ...params.userConfig, userKey: 'sk-user-nested-secret' }

  await engine.runSummaryJob(params, 'digest_userkey')
  const record = await store.loadJob('job_digest_userkey')
  assert(record.status === 'succeeded', 'userkey: job 正常完成')
  assert(!JSON.stringify(record).includes('sk-user-nested-secret'), 'userkey: 嵌套 userKey 不出现在序列化记录')
  assert(!JSON.stringify(record).includes('sk-test'), 'userkey: 顶层 apiKey 同样不出现')
}

// ---------- 20. 永不 settle 的 provider 调用不会挂死 job（有界孤儿等待） ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner({ hang: true })
  const engine = makeEngine(store, runner, { stepTimeoutMs: 30, stepMaxAttempts: 2, concurrency: 1 })
  const params = buildParams(syntheticItems(10, { bytesPerItem: 300 })) // 1 chunk

  const startedAt = Date.now()
  await expectJobFailure(() => engine.runSummaryJob(params, 'digest_hang'), 'TIMEOUT', 'hang: 以 TIMEOUT 收尾')
  const elapsed = Date.now() - startedAt
  assert(elapsed < 5_000, 'hang: 有界等待，job 有限时间内结束', `${elapsed}ms`)
  const record = await store.loadJob('job_digest_hang')
  assert(record.status === 'failed' && record.error.code === 'TIMEOUT', 'hang: 记录 TIMEOUT 终态')
}

// ---------- 21. 跨实例取消：共享取消标志 + 单一写者收尾 ----------
{
  const store = new MemoryJobStore()
  const slowRunner = recordingRunner({ chunkDelayMs: 120, reduceDelayMs: 200 })
  const engineA = makeEngine(store, slowRunner, { concurrency: 1 })
  const engineB = makeEngine(store, recordingRunner(), { lockWaitMs: 100 })
  const params = buildParams(syntheticItems(10, { bytesPerItem: 300 }))

  const running = engineA.runSummaryJob(params, 'digest_xcancel')
  await sleep(60) // A 持锁执行中
  assert(await engineB.cancel('job_digest_xcancel'), 'xcancel: 另一实例发起取消成功')
  await expectJobFailure(() => running, 'CANCELED', 'xcancel: 执行实例在检查点兑现取消')
  const record = await store.loadJob('job_digest_xcancel')
  assert(record.status === 'canceled', 'xcancel: 终态 canceled 而非 succeeded', record.status)
  assert((await store.isCancelRequested('job_digest_xcancel')) === false, 'xcancel: 终态后清取消标志')
}

// ---------- 22. digest 纳入 title ----------
{
  const base = buildParams(syntheticItems(5, { bytesPerItem: 300 }))
  const d1 = buildSummaryJobDigest({ ...base, title: '旧标题' })
  const d2 = buildSummaryJobDigest({ ...base, title: '新标题' })
  const d3 = buildSummaryJobDigest({ ...base, title: '  新标题  ' })
  assert(d1 !== d2, 'digest: 标题变化产生新 job')
  assert(d2 === d3, 'digest: 标题规范化（trim）后一致')
}

// ---------- 23. timestamp 模式 chunk 预算覆盖 JSON 膨胀 ----------
{
  const items = syntheticItems(60, { bytesPerItem: 200 })
  const chunks = chunkSubtitles(items, TIMESTAMP_CHUNK_BYTE_LIMIT)
  assert(chunks.length > 1, 'budget: timestamp 模式多 chunk')
  assert(
    chunks.every((chunk) => getUtf8ByteLength(JSON.stringify(chunk.text)) <= 6200),
    'budget: 序列化后不超过 prompt 二次限幅 6200',
    chunks.map((c) => getUtf8ByteLength(JSON.stringify(c.text))).join(','),
  )
}

// ---------- 24. canonical 回写：无 Redis 配置时 no-op 不抛错 ----------
{
  const hadUrl = process.env.UPSTASH_REDIS_REST_URL
  const hadToken = process.env.UPSTASH_REDIS_REST_TOKEN
  delete process.env.UPSTASH_REDIS_REST_URL
  delete process.env.UPSTASH_REDIS_REST_TOKEN
  const params = buildParams(syntheticItems(5, { bytesPerItem: 300 }))
  await writeJobResultToCanonicalCache(params, '## Summary\nok')
  assert(true, 'canonical: 无 env 时静默跳过')
  if (hadUrl) process.env.UPSTASH_REDIS_REST_URL = hadUrl
  if (hadToken) process.env.UPSTASH_REDIS_REST_TOKEN = hadToken
}

console.log(`\njobs fixtures: ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log('failures:')
  for (const f of failures) {
    console.log(`  - ${f}`)
  }
}
process.exitCode = failed > 0 ? 1 : 0
