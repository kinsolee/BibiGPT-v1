// 帧分析编排单测：内存 Supabase 桩 + VLM mock。
// 覆盖：(frameHash, model) 缓存命中不重复调 VLM、force 绕过、逐帧错误隔离、
// 幂等 refs.inputHash 必须是字符串（回归 KIN-42「哈希函数须 await」坑）。
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { SupabaseClient } from '@supabase/supabase-js'

import { analyzeFrameBatch, analyzeFrameRef } from '../analyze'
import { computeKeyframeSetId } from '../keyframeSelect'
import { computeKeyframesInputHash, persistKeyframeSet } from '../persist'
import { check, checkEqual, resetSuite, summary } from './harness'

type Row = Record<string, any>

interface QueryState {
  filters: Array<(row: Row) => boolean>
  orderCol?: string
  orderAsc: boolean
  limitN?: number
}

/** 最小 Supabase 桩：只实现 vision/persist 用到的链式查询 */
function createSupabaseStub(): SupabaseClient {
  const rows: Array<Row & { table: string }> = []
  const makeBuilder = (table: string) => {
    const state: QueryState = { filters: [], orderAsc: true }
    const apply = (): Array<Row & { table: string }> => {
      const matched = rows.filter((row) => row.table === table && state.filters.every((fn) => fn(row)))
      if (state.orderCol) {
        const col: string = state.orderCol
        const asc = state.orderAsc
        matched.sort((a, b) => (asc ? a[col] - b[col] : b[col] - a[col]))
      }
      return state.limitN !== undefined ? matched.slice(0, state.limitN) : matched
    }
    const builder: any = {
      select() {
        return builder
      },
      eq(col: string, value: any) {
        state.filters.push((row) => row[col] === value)
        return builder
      },
      contains(col: string, partial: Row) {
        state.filters.push((row) => Object.entries(partial).every(([key, value]) => (row[col] as Row)?.[key] === value))
        return builder
      },
      order(col: string, options?: { ascending?: boolean }) {
        state.orderCol = col
        state.orderAsc = options?.ascending !== false
        return builder
      },
      limit(n: number) {
        state.limitN = n
        return builder
      },
      maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
      single: async () => ({ data: apply()[0], error: null }),
      then(resolve: any, reject: any) {
        return Promise.resolve({ data: apply(), error: null }).then(resolve, reject)
      },
      insert(payload: Row) {
        const row: Row & { table: string } = { ...payload, table }
        if (!row.id) {
          row.id = `id_${rows.length}`
        }
        if (!row.version) {
          row.version = 1
        }
        rows.push(row)
        return {
          select() {
            return {
              single: async () => ({ data: { version: row.version }, error: null }),
            }
          },
        }
      },
    }
    return builder
  }
  return {
    from: (table: string) => makeBuilder(table),
  } as unknown as SupabaseClient
}

const CONTENT = {
  id: 'content-1',
  user_id: 'user-1',
  source_url: 'bibi-local:file/up_abc',
  service: 'local',
  source_ref: 'local:file:up_abc',
  source_page: null,
  title: 'test video',
  duration: 90,
  language: null,
  source_metadata: {},
  is_favorite: false,
  last_summarized_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as any

const VLM_OK = async () => ({ ocr: '字', description: '描述', tags: ['t'] })

async function run() {
  resetSuite()
  console.log('analyze cache & isolation')
  process.env.BIBI_VISION_MODEL = 'test-model'
  const visionDir = path.join(tmpdir(), `bibi-vision-test-${Date.now()}`)
  process.env.BIBI_VISION_DIR = visionDir

  const setId = computeKeyframeSetId({
    sourceRef: CONTENT.source_ref,
    threshold: 0.3,
    maxFrames: 24,
    minGapSeconds: 2,
    duration: 90,
  })
  const setDir = path.join(visionDir, 'sets', setId)
  await mkdir(setDir, { recursive: true })
  await writeFile(path.join(setDir, 'frame-000.jpg'), Buffer.from('frame-zero-bytes'))
  await writeFile(path.join(setDir, 'frame-001.jpg'), Buffer.from('frame-one-bytes'))

  const frames = [
    { frameId: 'kf_a', idx: 0, time: 0, setId, file: 'frame-000.jpg' },
    { frameId: 'kf_b', idx: 1, time: 5, setId, file: 'frame-001.jpg' },
  ]

  let vlmCalls = 0
  const countingVlm = (async (...args: Parameters<typeof VLM_OK>) => {
    vlmCalls += 1
    return VLM_OK(...args)
  }) as any

  const supabase = createSupabaseStub()
  const userId = 'user-1'
  const base = { supabase, userId, content: CONTENT, frames, model: 'test-model', vlmFn: countingVlm }

  const firstRun = await analyzeFrameBatch(base)
  checkEqual('首轮全部分析成功', [firstRun.okCount, firstRun.cachedCount, firstRun.errorCount], [2, 0, 0])
  checkEqual('首轮 VLM 调用 2 次', vlmCalls, 2)

  const secondRun = await analyzeFrameBatch(base)
  checkEqual('次轮全部命中缓存', [secondRun.okCount, secondRun.cachedCount, secondRun.errorCount], [0, 2, 0])
  checkEqual('缓存命中不再调 VLM', vlmCalls, 2)
  checkEqual('缓存返回与首轮一致', secondRun.results[0].analysis?.description, '描述')

  const forcedRun = await analyzeFrameBatch({ ...base, force: true })
  checkEqual('force 绕过缓存重算', forcedRun.okCount, 2)
  checkEqual('force 增加 VLM 调用', vlmCalls, 4)

  const secondFrameBase64 = Buffer.from('frame-one-bytes').toString('base64')
  const failingVlm = (async (image: { base64: string }) => {
    if (image.base64 === secondFrameBase64) {
      throw new Error('VLM 对第二帧超时')
    }
    return VLM_OK()
  }) as any
  const mixed = await analyzeFrameBatch({ ...base, vlmFn: failingVlm, force: true })
  checkEqual('单帧失败不影响其余帧', [mixed.okCount, mixed.errorCount], [1, 1])
  check('失败帧带错误信息', mixed.results[1].error?.includes('超时') ?? false, mixed.results[1])
  checkEqual('成功帧状态 ok', mixed.results[0].status, 'ok')

  const otherModel = await analyzeFrameRef({ ...base, frame: frames[0], model: 'other-model', force: false })
  checkEqual('不同模型视为缓存未命中', otherModel.status, 'ok')

  // 幂等与 inputHash 类型回归
  const inputHash = await computeKeyframesInputHash({
    sourceRef: CONTENT.source_ref,
    threshold: 0.3,
    maxFrames: 24,
    minGapSeconds: 2,
    duration: 90,
  })
  const keyframesRefs = { inputHash, setId, sourceRef: CONTENT.source_ref, threshold: 0.3 }
  const payload = {
    setId,
    mode: 'video' as const,
    threshold: 0.3,
    source: { service: 'local', sourceRef: CONTENT.source_ref, duration: 90 },
    frames: [],
    sceneCount: 0,
    illustrations: [],
    generatedAt: new Date().toISOString(),
  }
  const persistOnce = await persistKeyframeSet({
    supabase,
    userId,
    contentId: CONTENT.id,
    summaryId: null,
    payload,
    refs: keyframesRefs,
  })
  const persistTwice = await persistKeyframeSet({
    supabase,
    userId,
    contentId: CONTENT.id,
    summaryId: null,
    payload,
    refs: keyframesRefs,
  })
  checkEqual('keyframes 幂等复用', [persistOnce.reused, persistTwice.reused], [false, true])
  check(
    'refs.inputHash 是字符串而非 Promise',
    typeof keyframesRefs.inputHash === 'string',
    typeof keyframesRefs.inputHash,
  )
  checkEqual('版本号递增', persistOnce.version, 1)

  summary('analyzeCache')
}

export { run as runAnalyzeCacheTests }
