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
import {
  DEFAULT_REDUCE_INPUT_BYTE_LIMIT,
  groupSectionsForReduce,
  runSummaryToCompletion,
  startSummaryJobInBackground,
  writeJobResultToCanonicalCache,
} from '../summaryJob.ts'

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
    run1.every(
      (chunk) =>
        chunk.hash ===
        createHash('sha256')
          .update(JSON.stringify({ text: chunk.text, startSeconds: chunk.startSeconds, endSeconds: chunk.endSeconds }))
          .digest('hex')
          .slice(0, 16),
    ),
    'chunk: hash 为文本+起止秒的 sha256 前 16 位（固定）',
  )

  // timing 参与身份：时间轴修正后 hash 变化（新 job，不复用旧时间戳）
  const shifted = items.map((item, i) => ({ ...item, s: i * 20 }))
  const shiftedChunks = chunkSubtitles(shifted)
  const byText = new Map(shiftedChunks.map((c) => [c.text, c.hash]))
  assert(
    run1.every((chunk) => byText.get(chunk.text) !== chunk.hash),
    'chunk: 同文本不同 timing 产生不同 hash',
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

// ---------- 10. provider 错误页/裸 JSON 错误体拦截 ----------
{
  assert(isLikelyHtmlErrorPage('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>'), 'html: doctype 错误页')
  assert(isLikelyHtmlErrorPage('<html>Service Unavailable'), 'html: 无 doctype 错误页')
  assert(!isLikelyHtmlErrorPage('## Summary\n正常摘要 <重要> 内容'), 'html: 正常摘要不误伤')
  assert(!isLikelyHtmlErrorPage(''), 'html: 空文本不是错误页')
  assert(!isValidSummaryText('   '), 'valid: 空白文本无效')

  // 裸 JSON 错误体（网关 2xx + {"error": ...} 形态）
  assert(!isValidSummaryText('{"error":"rate_limit"}'), 'json: 裸 rate_limit 错误体拒绝')
  assert(!isValidSummaryText('{"error":{"message":"Invalid API key provided"}}'), 'json: 嵌套错误对象拒绝')
  assert(!isValidSummaryText('{"errors":["timeout"]}'), 'json: errors 数组拒绝')
  assert(!isValidSummaryText('{"status_code":429,"message":"Too Many Requests"}'), 'json: status_code 错误体拒绝')
  // 正常内容不误伤
  assert(isValidSummaryText('## Summary\n正常摘要要点'), 'json: markdown 摘要有效')
  assert(isValidSummaryText('["要点一","要点二"]'), 'json: 数组形态非错误体')
  assert(isValidSummaryText('{"summary":"要点"}'), 'json: 无错误特征键的 JSON 不误伤')
  assert(isValidSummaryText('{"a":1} broken json'), 'json: 解析失败按正文处理')

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

  // 裸 JSON 错误体同样判死
  const store2 = new MemoryJobStore()
  const runner2 = recordingRunner()
  runner2.runChunk = async () => '{"error":"rate_limit","retry_after":30}'
  const engine2 = makeEngine(store2, runner2)
  await expectJobFailure(
    () => engine2.runSummaryJob(params, 'digest_jsonerr'),
    'PROVIDER_ERROR_PAGE',
    'json: 裸 JSON 错误体导致 job 失败',
  )
  const record2 = await store2.loadJob('job_digest_jsonerr')
  assert(record2.error.code === 'PROVIDER_ERROR_PAGE', 'json: 记录 PROVIDER_ERROR_PAGE')
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

// ---------- 25. 分层 reduce 分组：保序装箱、有界、可收敛 ----------
{
  const section = (bytes) => 'x'.repeat(bytes)
  const sections = [section(600), section(700), section(300), section(800), section(100)]
  const groups = groupSectionsForReduce(sections, 1_000)
  assert(groups.length >= 2, 'group: 超上界分组')
  assert(
    groups.every((group) => getUtf8ByteLength(group.join('\n\n')) <= 1_000),
    'group: 每组含分隔不超上界',
  )
  assert(groups.flat().length === sections.length, 'group: 无丢失')
  assert(JSON.stringify(groups.flat()) === JSON.stringify(sections), 'group: 保序')
  const oversize = groupSectionsForReduce([section(5_000), section(100)], 1_000)
  assert(oversize.length === 2 && oversize[0].length === 1, 'group: 超大单条自成一组')
  // 默认上界可用：数量级正确
  assert(DEFAULT_REDUCE_INPUT_BYTE_LIMIT >= 10_000, 'group: 默认上界为常量')

  // 模拟分层收敛：每层合并后组数下降，最终 ≤1
  let current = Array.from({ length: 40 }, () => section(2_000)) // 80KB
  let levels = 0
  while (
    current.length > 1 &&
    getUtf8ByteLength(current.join('\n\n')) > DEFAULT_REDUCE_INPUT_BYTE_LIMIT &&
    levels < 8
  ) {
    levels += 1
    const parts = groupSectionsForReduce(current, DEFAULT_REDUCE_INPUT_BYTE_LIMIT)
    current = parts.map((group) => group.join('\n\n')) // 中间层理想化：同长度输出
  }
  assert(levels >= 1 && current.length >= 1, 'group: 多层收敛路径成立')
}

// ---------- 26. 分布式锁执行期间续约（超长 job 不因 TTL 过期被抢） ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner({ chunkDelayMs: 120, reduceDelayMs: 80 })
  // TTL 120ms、续约 30ms：无续约时锁会在 job（>300ms）结束前过期
  const engine = makeEngine(store, runner, { lockTtlMs: 120, lockRenewIntervalMs: 30 })
  const params = buildParams(syntheticItems(20, { bytesPerItem: 300 })) // 2 chunks

  const running = engine.runSummaryJob(params, 'digest_renew')
  await sleep(200) // 已超过原始 TTL（120ms）
  assert(await store.hasJobLock('job_digest_renew'), 'renew: 执行期间锁仍被持有（续约生效）')
  const { snapshot } = await running
  assert(snapshot.record.status === 'succeeded', 'renew: job 正常完成')
  assert(!(await store.hasJobLock('job_digest_renew')), 'renew: 完成后锁释放')

  // renewJobLock 语义：非持有者续约被拒
  const lockStore2 = new MemoryJobStore()
  await lockStore2.acquireJobLock('k', 'h1', 60_000)
  assert((await lockStore2.renewJobLock('k', 'h2', 60_000)) === false, 'renew: 他人续约被拒')
  assert((await lockStore2.renewJobLock('k', 'h1', 60_000)) === true, 'renew: 持有者续约成功')
  await lockStore2.releaseJobLock('k', 'h1')
}

// ---------- 27. 异步入队：返回前 job 记录已落盘（轮询不 404） ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner({ chunkDelayMs: 100 })
  const engine = makeEngine(store, runner)
  const params = buildParams(syntheticItems(10, { bytesPerItem: 300 }))

  const { jobId } = await startSummaryJobInBackground(params, { engine })
  assert(jobId === `job_${buildSummaryJobDigest(params)}`, 'bg: jobId 确定性')
  const record = await store.loadJob(jobId)
  assert(record !== null, 'bg: 返回时记录已存在')
  assert(['queued', 'running'].includes(record.status), 'bg: 初始状态可轮询', record.status)
  await sleep(400) // 等后台完成，避免悬挂 promise 影响后续
  const finalRecord = await store.loadJob(jobId)
  assert(finalRecord.status === 'succeeded', 'bg: 后台执行完成')
}

// ---------- 28. steps 缺失时保留原 record（不抹 succeeded/checkpoint） ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner()
  const engine = makeEngine(store, runner)
  const params = buildParams(syntheticItems(10, { bytesPerItem: 300 }))
  await engine.runSummaryJob(params, 'digest_steps_missing')
  const before = await store.loadJob('job_digest_steps_missing')
  assert(before.status === 'succeeded', 'steps-missing: 前置成功')

  store.steps.delete('job_digest_steps_missing') // 模拟 steps 独立过期/损坏
  const { snapshot } = await engine.runSummaryJob(params, 'digest_steps_missing')
  assert(
    snapshot.record.status === 'succeeded' && snapshot.record.attempt === before.attempt,
    'steps-missing: 记录原样保留（不复位为 queued）',
  )
  assert(snapshot.record.resultText === before.resultText, 'steps-missing: 结果不丢')
  assert(snapshot.steps.length === params.chunks.length + 1, 'steps-missing: steps 已重建')
  assert(runner.state.chunkCalls.length === params.chunks.length, 'steps-missing: 复用路径零 provider 调用')
}

// ---------- 29. cancel 直接收尾清共享标志，同 digest 可重新执行 ----------
{
  const store = new MemoryJobStore()
  const params = buildParams(syntheticItems(10, { bytesPerItem: 300 }))
  const engine = makeEngine(store, recordingRunner())
  const otherEngine = makeEngine(store, recordingRunner())

  // 无 worker 的 queued job：由 otherEngine 直接收尾
  await engine.ensureJobRecord('job_digest_cancelclear', 'digest_cancelclear', params)
  assert(await otherEngine.cancel('job_digest_cancelclear'), 'cancelclear: 直接收尾成功')
  assert((await store.isCancelRequested('job_digest_cancelclear')) === false, 'cancelclear: 共享取消标志已清')

  // 同 digest 重新执行不被过期标志拦截
  const { snapshot } = await otherEngine.runSummaryJob(params, 'digest_cancelclear')
  assert(snapshot.record.status === 'succeeded', 'cancelclear: canceled job 重启执行成功')
}

// ---------- 30. digest 纳入有效输出预算 detailTokens ----------
{
  const base = buildParams(syntheticItems(5, { bytesPerItem: 300 }))
  const d1 = buildSummaryJobDigest({ ...base, detailTokens: 600 })
  const d2 = buildSummaryJobDigest({ ...base, detailTokens: 800 })
  assert(d1 !== d2, 'digest: 输出预算变化产生新 job')
}

// ---------- 31. failed job 重跑：running 写入前必须已移出 failed 索引 ----------
{
  // 制造一个 failed job（在 failed 索引中）
  const seedStore = new MemoryJobStore()
  const failRunner = recordingRunner({ failChunkIndexes: new Set([0]) })
  failRunner.state.failTimes = 99
  const seedEngine = makeEngine(seedStore, failRunner)
  const params = buildParams(syntheticItems(5, { bytesPerItem: 300 }))
  await expectJobFailure(() => seedEngine.runSummaryJob(params, 'digest_cleanup_race'), null, 'cleanup-race: 前置失败')

  // 用顺序追踪 store 重跑：saveJob(running) 时 failed 索引必须已清空
  let failedIndexEmptyWhenRunningSaved = null
  class OrderTrackingStore extends MemoryJobStore {
    async saveJob(record) {
      if (record.status === 'running') {
        failedIndexEmptyWhenRunningSaved = (await this.listFailedJobIds()).length === 0
      }
      return super.saveJob(record)
    }
  }
  const trackingStore = new OrderTrackingStore()
  // 把 failed job 迁入追踪 store（直接复制内部状态）
  trackingStore.jobs.set('job_digest_cleanup_race', seedStore.jobs.get('job_digest_cleanup_race'))
  trackingStore.steps.set('job_digest_cleanup_race', seedStore.steps.get('job_digest_cleanup_race'))
  await trackingStore.addFailedIndex('job_digest_cleanup_race', Date.now())

  const engine = makeEngine(trackingStore, recordingRunner())
  const { snapshot } = await engine.runSummaryJob(params, 'digest_cleanup_race')
  assert(snapshot.record.status === 'succeeded', 'cleanup-race: 重跑成功')
  assert(failedIndexEmptyWhenRunningSaved === true, 'cleanup-race: running 落盘前已移出 failed 索引')
  assert((await trackingStore.listFailedJobIds()).length === 0, 'cleanup-race: 成功后不在 failed 索引')
}

// ---------- 32. timestamp 最坏转义：编码后仍不触发 6200 二次截断 ----------
{
  // 全 ASCII 引号+反斜杠：JSON.stringify 后逐字符近翻倍（历史最坏情况）
  const nasty = Array.from({ length: 300 }, (_, i) => ({
    text: `line${i} ` + '"\\\\'.repeat(30),
    index: i,
    s: i * 10,
  }))
  const chunks = chunkSubtitles(nasty, TIMESTAMP_CHUNK_BYTE_LIMIT, { encodedWeight: true })
  assert(chunks.length > 1, 'worst: 多 chunk')
  assert(
    chunks.every((chunk) => getUtf8ByteLength(JSON.stringify(chunk.text)) <= 6200),
    'worst: 编码后不超 6200（prompt 二次限幅不触发）',
    chunks.map((c) => getUtf8ByteLength(JSON.stringify(c.text))).join(','),
  )
  assert(
    chunks.every((chunk) => chunk.byteLength <= 6200),
    'worst: 原始字节同样不超 6200',
  )
  const reassembled = chunks.map((c) => c.text).join(' ')
  assert(reassembled === nasty.map((i) => i.text).join(' '), 'worst: 零丢失')
  const oversizeSingle = [{ text: '"\\'.repeat(8000), index: 0, s: 1 }] // 编码后 32000 bytes
  const hardSplit = chunkSubtitles(oversizeSingle, TIMESTAMP_CHUNK_BYTE_LIMIT, { encodedWeight: true })
  assert(
    hardSplit.every((c) => getUtf8ByteLength(JSON.stringify(c.text)) <= 6200),
    'worst: 超大单条硬切也按编码预算',
  )
  assert(hardSplit.map((c) => c.text).join('') === oversizeSingle[0].text, 'worst: 硬切零丢失')
}

// ---------- 33. 续约被拒（锁被抢）→ LOST_LOCK 停工，不再写状态 ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner({ chunkDelayMs: 150, reduceDelayMs: 100 })
  // TTL 50ms、续约间隔 100ms：第一次续约前锁已过期并可被 intruder 抢占
  const engine = makeEngine(store, runner, { lockTtlMs: 50, lockRenewIntervalMs: 100, concurrency: 1 })
  const params = buildParams(syntheticItems(20, { bytesPerItem: 300 })) // 2 chunks

  const running = engine.runSummaryJob(params, 'digest_lostlock')
  await sleep(70) // 原 TTL 已过、尚未到续约点
  assert(await store.acquireJobLock('job_digest_lostlock', 'intruder', 60_000), 'lostlock: intruder 抢到过期锁')
  await expectJobFailure(() => running, 'LOST_LOCK', 'lostlock: 以 LOST_LOCK 放弃执行')
  const record = await store.loadJob('job_digest_lostlock')
  assert(record.status === 'running', 'lostlock: 原执行者不再覆盖状态（停留在 running）', record.status)
  await store.releaseJobLock('job_digest_lostlock', 'intruder')
}

// ---------- 34. cancel 不会覆盖并发执行者已写入的终态 ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner()
  const engine = makeEngine(store, runner)
  const params = buildParams(syntheticItems(5, { bytesPerItem: 300 }))
  await engine.runSummaryJob(params, 'digest_cancel_terminal')
  const before = await store.loadJob('job_digest_cancel_terminal')
  assert(before.status === 'succeeded', 'cancel-terminal: 前置 succeeded')

  // 他实例持锁 + job 已终态：cancel 快速路径直接拒绝
  await store.acquireJobLock('job_digest_cancel_terminal', 'worker-x', 60_000)
  assert((await engine.cancel('job_digest_cancel_terminal')) === false, 'cancel-terminal: succeeded 拒绝取消')
  await store.releaseJobLock('job_digest_cancel_terminal', 'worker-x')

  // queued job + 他实例持锁：cancel 只置共享标志，不抢写终态
  await engine.ensureJobRecord('job_digest_cancel_race', 'digest_cancel_race', params)
  await store.acquireJobLock('job_digest_cancel_race', 'worker-y', 60_000)
  assert((await engine.cancel('job_digest_cancel_race')) === true, 'cancel-terminal: 锁被占时取消仍受理')
  const raced = await store.loadJob('job_digest_cancel_race')
  assert(raced.status === 'queued', 'cancel-terminal: 终态留给持锁执行者决定', raced.status)
  assert((await store.isCancelRequested('job_digest_cancel_race')) === true, 'cancel-terminal: 共享标志已置')
  await store.releaseJobLock('job_digest_cancel_race', 'worker-y')
}

// ---------- 35. backoff 中的取消在重试前兑现（无谓 attempt 不发出） ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner({ failChunkIndexes: new Set([0]), failTimes: 1 })
  const engine = makeEngine(store, runner, { concurrency: 1, stepBackoffMs: 150 })
  const params = buildParams(syntheticItems(20, { bytesPerItem: 300 })) // 2 chunks

  const running = engine.runSummaryJob(params, 'digest_retry_cancel')
  await sleep(50) // chunk0 attempt1 已失败、正处于 backoff
  assert(await engine.cancel('job_digest_retry_cancel'), 'retry-cancel: 取消受理')
  await expectJobFailure(() => running, 'CANCELED', 'retry-cancel: 以 CANCELED 结束')
  assert(
    runner.state.chunkCalls.length === 1,
    'retry-cancel: 重试 attempt 未发出',
    JSON.stringify(runner.state.chunkCalls),
  )
  const record = await store.loadJob('job_digest_retry_cancel')
  assert(record.status === 'canceled', 'retry-cancel: 终态 canceled')
}

// ---------- 36. cleanup 逐个持锁重读：不删重跑中的 job ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner({ failChunkIndexes: new Set([0]) })
  runner.state.failTimes = 99
  const engine = makeEngine(store, runner)
  const params = buildParams(syntheticItems(5, { bytesPerItem: 300 }))
  await expectJobFailure(() => engine.runSummaryJob(params, 'digest_cleanup_guard'), null, 'cleanup-guard: 前置失败')

  // 模拟另一实例正在重跑该 job（持有执行锁）
  await store.acquireJobLock('job_digest_cleanup_guard', 'resumer', 60_000)
  const cleaner = makeEngine(store, recordingRunner())
  const removedWhileRunning = await cleaner.cleanupFailedJobs()
  assert(removedWhileRunning === 0, 'cleanup-guard: 锁被占时零清理', String(removedWhileRunning))
  assert((await store.loadJob('job_digest_cleanup_guard')) !== null, 'cleanup-guard: 重跑中的记录未被删')

  await store.releaseJobLock('job_digest_cleanup_guard', 'resumer')
  const removedAfter = await cleaner.cleanupFailedJobs()
  assert(removedAfter === 1, 'cleanup-guard: 释放后正常清理')
  assert((await store.loadJob('job_digest_cleanup_guard')) === null, 'cleanup-guard: 记录已删')

  // 记录已过期（loadJob null）的索引残留也一并清（olderThanMs 为绝对时间戳）
  await store.addFailedIndex('job_expired_ghost', Date.now() - 5000)
  assert((await cleaner.cleanupFailedJobs(Date.now() - 2000)) === 1, 'cleanup-guard: 过期残留索引清理')
}

// ---------- 37. active 索引惰性清理（终态/过期残留不返回且被移除） ----------
{
  const store = new MemoryJobStore()
  const engine = makeEngine(store, recordingRunner())
  const params = buildParams(syntheticItems(5, { bytesPerItem: 300 }))
  await engine.runSummaryJob(params, 'digest_active_prune')

  // 模拟崩溃残留：succeeded 后仍挂在 active 索引
  await store.addActiveIndex('job_digest_active_prune', Date.now())
  await store.addActiveIndex('job_ghost', Date.now()) // 记录不存在（已过期）
  const active = await engine.listActiveJobs()
  assert(active.length === 0, 'active-prune: 无残留返回', JSON.stringify(active))
  assert((await store.listActiveJobIds()).length === 0, 'active-prune: 残留索引已清')
}

// ---------- 38. 分层 reduce 区间：sectionRanges 优先于位置推导 ----------
{
  const chunks = chunkSubtitles(syntheticItems(60, { bytesPerItem: 200 }))
  const videoConfig = { videoId: 'BV1test', sentenceNumber: 7 }
  const mergedOutputs = ['合并组 A 要点', '合并组 B 要点', '合并组 C 要点']
  const mergedRanges = [
    { startSeconds: 0, endSeconds: 300 },
    { startSeconds: 300, endSeconds: 700 },
    { startSeconds: 700, endSeconds: 1200 },
  ]
  const prompt = buildReduceUserPrompt({
    title: '区间测试',
    chunks,
    chunkOutputs: mergedOutputs,
    videoConfig,
    sectionRanges: mergedRanges,
  })
  assert(prompt.includes('Section 2/3 (5:00–11:40)'), 'ranges: 中间层区间按并集标注')
  const fallbackPrompt = buildReduceUserPrompt({
    title: '区间测试',
    chunks,
    chunkOutputs: chunks.map((c) => `第${c.index + 1}段`),
    videoConfig,
  })
  assert(fallbackPrompt.includes('Section 1/'), 'ranges: 未传区间时退回位置推导')
}

// ---------- 39. force 重置写入失败：锁与 timer 仍被清理（不锁死 job） ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner()
  const engine = makeEngine(store, runner)
  const params = buildParams(syntheticItems(5, { bytesPerItem: 300 }))
  await engine.runSummaryJob(params, 'digest_force_fail')

  class FailingForceResetStore extends MemoryJobStore {
    constructor(inner) {
      super()
      this.jobs = inner.jobs
      this.steps = inner.steps
      this.failForceReset = false
    }
    async saveJob(record) {
      const existed = this.jobs.get(record.id)
      if (this.failForceReset && existed && existed.status === 'succeeded' && record.status === 'queued') {
        throw new Error('mock redis transient failure on force reset')
      }
      return super.saveJob(record)
    }
  }
  const failingStore = new FailingForceResetStore(store)
  failingStore.failForceReset = true
  const failingEngine = makeEngine(failingStore, recordingRunner())

  let rejected = false
  try {
    await failingEngine.runSummaryJob(params, 'digest_force_fail', { forceNewResult: true })
  } catch (error) {
    rejected = true
    assert(!(error instanceof JobFailureError) || error.code !== 'CANCELED', 'force-fail: 非取消类错误')
  }
  assert(rejected, 'force-fail: 重置写入失败向上抛出')
  // 关键：锁必须已释放（cleanup 段覆盖了重置写入），job 不会被无限续约锁死
  assert(await failingStore.acquireJobLock('job_digest_force_fail', 'next', 60_000), 'force-fail: 失败后锁可用')
  await failingStore.releaseJobLock('job_digest_force_fail', 'next')
  const record = await failingStore.loadJob('job_digest_force_fail')
  assert(record.status === 'succeeded' && record.resultText, 'force-fail: 原结果未被破坏')
}

// ---------- 40. 丢锁后 step 完成回调不写状态、不清共享取消标志 ----------
{
  const store = new MemoryJobStore()
  const runner = recordingRunner({ chunkDelayMs: 150, reduceDelayMs: 100 })
  const engine = makeEngine(store, runner, { lockTtlMs: 50, lockRenewIntervalMs: 100, concurrency: 1 })
  const params = buildParams(syntheticItems(20, { bytesPerItem: 300 })) // 2 chunks

  const running = engine.runSummaryJob(params, 'digest_lostlock_write')
  await sleep(30) // 让 cancel 与丢锁都发生在 chunk#0 在途时
  await store.requestCancel('job_digest_lostlock_write')
  await sleep(50) // TTL 过期
  assert(await store.acquireJobLock('job_digest_lostlock_write', 'intruder', 60_000), 'lostlock-write: intruder 拿锁')
  await expectJobFailure(() => running, 'LOST_LOCK', 'lostlock-write: 以 LOST_LOCK 放弃')
  // chunk#0 已成功返回，但完成回调在丢锁后不得写入
  const steps = await store.loadSteps('job_digest_lostlock_write')
  const chunk0 = steps.find((s) => s.chunkIndex === 0)
  assert(chunk0.status !== 'succeeded', 'lostlock-write: 丢锁后完成回调未写 succeeded', chunk0.status)
  // 旧 worker 丢锁退出不清共享取消标志（留给新持有者兑现）
  assert((await store.isCancelRequested('job_digest_lostlock_write')) === true, 'lostlock-write: 取消标志保留')

  // 新持有者接手：检查点兑现取消 → CANCELED 终态
  await store.releaseJobLock('job_digest_lostlock_write', 'intruder')
  const engineB = makeEngine(store, recordingRunner(), { lockWaitMs: 100 })
  await expectJobFailure(
    () => engineB.runSummaryJob(params, 'digest_lostlock_write'),
    'CANCELED',
    'lostlock-write: 新持有者兑现取消',
  )
}

// ---------- 41. 后台启动失败迁移为 failed（轮询可见可重试） ----------
{
  const store = new MemoryJobStore()
  const engine = makeEngine(store, recordingRunner())
  const params = buildParams(syntheticItems(5, { bytesPerItem: 300 }))

  const { jobId } = await startSummaryJobInBackground(params, { engine })
  // 让后台执行必然失败于启动阶段：直接占住执行锁
  await store.acquireJobLock(jobId, 'blocker', 60_000)
  // 手动触发一次后台执行失败路径：用 runSummaryToCompletion 的锁等待超时
  const tinyEngine = makeEngine(store, recordingRunner(), { lockWaitMs: 30, lockRetryIntervalMs: 10 })
  await expectJobFailure(
    () => runSummaryToCompletion(params, { engine: tinyEngine }),
    'JOB_LOCK_BUSY',
    'bg-fail: 启动锁忙失败',
  ).then(async () => {
    // 模拟 startSummaryJobInBackground 的 failover：未终态记录迁移 failed
    const moved = await tinyEngine.failJobIfNotTerminal(jobId, 'BACKGROUND_START_FAILED', 'lock busy in test')
    assert(moved === true, 'bg-fail: 未终态记录迁移 failed')
    const record = await store.loadJob(jobId)
    assert(record.status === 'failed' && record.error.code === 'BACKGROUND_START_FAILED', 'bg-fail: 终态与错误码可轮询')
    assert((await store.listFailedJobIds()).includes(jobId), 'bg-fail: 进入失败队列可重试')
  })
  await store.releaseJobLock(jobId, 'blocker')
}

console.log(`\njobs fixtures: ${passed} passed, ${failed} failed`)
if (failures.length) {
  console.log('failures:')
  for (const f of failures) {
    console.log(`  - ${f}`)
  }
}
process.exitCode = failed > 0 ? 1 : 0
