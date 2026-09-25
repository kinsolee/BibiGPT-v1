#!/usr/bin/env node
/**
 * KIN-44 contract verification.
 *
 * Usage:
 *   node scripts/verify-kin44.mjs --mode prod   # requires `next build` first (server started automatically)
 *   node scripts/verify-kin44.mjs --mode dev    # uses `next dev`
 *   node scripts/verify-kin44.mjs --base-url http://localhost:3210  # against an already-running server
 *
 * Optional overrides: --video-id, --model-a, --model-b, --port.
 *
 * Checks:
 *   1. /api/openrouter/models: text-capable catalog, defaultModel present, no image/audio-only ids
 *   2. Non-stream summarize against a real model returns 200 + non-empty content
 *   3. Stream summarize (/api/chat) returns 200 and multiple chunks
 *   4. Switching model / language / emoji produces distinct cache keys in Upstash
 *   5. Nonexistent model returns an identifiable MODEL_NOT_FOUND error and writes no cache key
 *   6. No API key value shows up in any response body or server log
 */

import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')

function parseArgs(argv) {
  const args = { mode: 'prod', port: '3210', service: 'youtube' }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, '')
    if (
      key === 'mode' ||
      key === 'base-url' ||
      key === 'video-id' ||
      key === 'model-a' ||
      key === 'model-b' ||
      key === 'port' ||
      key === 'service'
    ) {
      args[key] = argv[i + 1]
      i += 1
    }
  }
  return args
}

function loadEnvFile(file) {
  const env = {}
  if (!existsSync(file)) {
    return env
  }
  const interpolate = (value) => value.replace(/\$\{(\w+)\}/g, (_, name) => env[name] ?? process.env[name] ?? '')
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/)
    if (!match || line.trim().startsWith('#')) {
      continue
    }
    env[match[1]] = interpolate(match[2].replace(/^['"]|['"]$/g, ''))
  }
  return env
}

const fileEnv = loadEnvFile(resolve(repoRoot, '.env'))
const env = { ...process.env, ...fileEnv }
const args = parseArgs(process.argv.slice(2))
const baseUrl = args['base-url'] || `http://localhost:${args.port}`

const results = []
function record(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const VIDEO_ID =
  args['video-id'] || env.VERIFY_VIDEO_ID || (args.service === 'bilibili' ? 'BV1AL4y1j7RY' : 'kJQP7kiw5Fk')
const NONEXISTENT_MODEL = 'bibigpt/kin44-nonexistent-model'

const secretCandidates = [
  env.OPENAI_COMPATIBLE_API_KEY,
  env.OPENAI_API_KEY,
  env.OPENROUTER_API_KEY,
  env.UPSTASH_REDIS_REST_TOKEN,
].filter((value) => value && value.length > 8)

const responseBodies = []
let serverLog = ''
let serverProcess = null

function startServer() {
  if (args['base-url']) {
    console.log(`Using existing server at ${baseUrl}`)
    return Promise.resolve()
  }
  if (args.mode === 'prod' && !existsSync(resolve(repoRoot, '.next', 'BUILD_ID'))) {
    console.error('No .next/BUILD_ID found. Run `npm run build` before --mode prod.')
    process.exit(2)
  }
  const command = args.mode === 'dev' ? 'next' : 'next'
  const commandArgs = args.mode === 'dev' ? ['dev', '-p', args.port] : ['start', '-p', args.port]
  serverProcess = spawn(resolve(repoRoot, 'node_modules', '.bin', command), commandArgs, {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProcess.stdout.on('data', (chunk) => {
    serverLog += chunk.toString()
  })
  serverProcess.stderr.on('data', (chunk) => {
    serverLog += chunk.toString()
  })
  console.log(`Starting ${args.mode} server on :${args.port}`)
  return waitForServer()
}

async function waitForServer() {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/openrouter/models`, { signal: AbortSignal.timeout(5000) })
      if (response.ok) {
        return
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error('server did not become ready in 180s')
}

async function fetchJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) })
  const body = await response.text()
  responseBodies.push(body)
  let json = null
  try {
    json = JSON.parse(body)
  } catch {
    // keep raw body
  }
  return { status: response.status, body, json }
}

function baseVideoConfig(overrides = {}) {
  return {
    videoId: VIDEO_ID,
    service: args.service,
    enableStream: false,
    outputLanguage: 'zh-CN',
    showTimestamp: false,
    showEmoji: true,
    sentenceNumber: 5,
    outlineLevel: 1,
    detailLevel: 600,
    ...overrides,
  }
}

async function summarize(videoConfig) {
  const response = await fetch(`${baseUrl}/api/sumup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videoConfig, userConfig: {} }),
    signal: AbortSignal.timeout(180_000),
  })
  const body = await response.text()
  responseBodies.push(body)
  return { status: response.status, body }
}

async function summarizeStream(videoConfig) {
  // Count time-separated data events on the raw HTTP response; fetch/undici
  // coalesces streamed bytes into one read and hides the chunking.
  const target = new URL(`${baseUrl}/api/chat`)
  const payload = JSON.stringify({ videoConfig: { ...videoConfig, enableStream: true }, userConfig: {} })
  return await new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (response) => {
        let text = ''
        let chunks = 0
        let lastEventAt = 0
        response.setEncoding('utf8')
        response.on('data', (piece) => {
          text += piece
          const now = Date.now()
          if (now - lastEventAt >= 30) {
            chunks += 1
            lastEventAt = now
          }
        })
        response.on('end', () => {
          responseBodies.push(text)
          resolvePromise({ status: response.statusCode ?? 0, body: text, chunks })
        })
        response.on('error', rejectPromise)
      },
    )
    req.on('error', rejectPromise)
    req.setTimeout(180_000, () => req.destroy(new Error('stream request timeout')))
    req.end(payload)
  })
}

async function upstashKeys(pattern) {
  const url = env.UPSTASH_REDIS_REST_URL
  const token = env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) {
    return null
  }
  const response = await fetch(url.replace(/\/+$/, ''), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(['keys', pattern]),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`upstash keys ${pattern} failed: ${response.status}`)
  }
  const payload = await response.json()
  const list = payload && typeof payload === 'object' && 'result' in payload ? payload.result : payload
  return Array.isArray(list) ? list : []
}

function normalizeModelId(model) {
  return model.replace(/[^\w.-]/g, '_')
}

function isLocalMockRedis() {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(env.UPSTASH_REDIS_REST_URL).hostname)
  } catch {
    return false
  }
}

async function flushLocalMockRedis() {
  if (!isLocalMockRedis()) {
    return
  }
  await fetch(env.UPSTASH_REDIS_REST_URL.replace(/\/+$/, ''), {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(['flushall']),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {})
  console.log('flushed local mock redis for a clean run')
}

async function main() {
  await startServer()
  await flushLocalMockRedis()

  // 1. model catalog
  const models = await fetchJson(`${baseUrl}/api/openrouter/models`)
  const payload = models.json || {}
  const catalogModels = payload.models || []
  record(
    'catalog: returns 200 with models',
    models.status === 200 && catalogModels.length > 0,
    `source=${payload.source} count=${catalogModels.length} defaultModel=${payload.defaultModel}`,
  )
  record('catalog: defaultModel is set', typeof payload.defaultModel === 'string' && payload.defaultModel.length > 0)
  const nonTextIds = catalogModels
    .map((m) => m.id)
    .filter((id) => /dall-e|flux|stable-diffusion|whisper|tts|sora|veo|imagen/i.test(id))
  record('catalog: no obvious non-text models', nonTextIds.length === 0, nonTextIds.slice(0, 5).join(','))
  const modelA = args['model-a'] || payload.defaultModel || env.OPENAI_COMPATIBLE_MODEL
  const modelB =
    args['model-b'] ||
    catalogModels.find((m) => m.id !== modelA && !/:free$/.test(m.id))?.id ||
    catalogModels.find((m) => m.id !== modelA)?.id
  console.log(`modelA=${modelA} modelB=${modelB || '(none)'}`)

  // 2. non-stream real call
  const nonStream = await summarize(baseVideoConfig({ model: modelA }))
  record(
    `sumup non-stream (${modelA}): 200 with content`,
    nonStream.status === 200 && nonStream.body.trim().length > 50,
    `status=${nonStream.status} chars=${nonStream.body.length}`,
  )

  // 3. stream real call
  const stream = await summarizeStream(baseVideoConfig({ model: modelA, detailLevel: 400 }))
  record(
    `chat stream (${modelA}): 200 with multiple chunks`,
    stream.status === 200 && stream.body.trim().length > 50 && stream.chunks > 1,
    `status=${stream.status} chunks=${stream.chunks} chars=${stream.body.length}`,
  )

  // 4. cache key isolation
  if (modelB) {
    const switched = await summarize(baseVideoConfig({ model: modelB }))
    record(
      `sumup model switch (${modelB}): 200`,
      switched.status === 200 && switched.body.trim().length > 50,
      `status=${switched.status} chars=${switched.body.length}`,
    )
  }
  await summarize(baseVideoConfig({ model: modelA, showEmoji: false, outputLanguage: 'en-US' }))
  const keys = await upstashKeys(`*${VIDEO_ID}*`)
  const normalizedA = normalizeModelId(modelA)
  const normalizedB = modelB ? normalizeModelId(modelB) : null
  const keysWithA = (keys || []).filter((k) => k.includes(normalizedA))
  const keysWithB = normalizedB ? (keys || []).filter((k) => k.includes(normalizedB)) : []
  const emojiVariantKeys = (keys || []).filter((k) => k.includes('noemoji'))
  record(
    'cache: distinct keys per model',
    keys !== null && keysWithA.length >= 2 && keysWithB.length >= 1,
    `A-keys=${keysWithA.length} B-keys=${keysWithB.length} total=${keys ? keys.length : 'n/a'}`,
  )
  record(
    'cache: emoji/language variant keys exist',
    keys !== null && emojiVariantKeys.length >= 1,
    emojiVariantKeys.slice(0, 3).join(' | '),
  )
  if (keys) {
    console.log('cache keys:')
    for (const key of keys.sort()) {
      console.log(`  ${key}`)
    }
  }

  // 5. failure path
  const failure = await summarize(baseVideoConfig({ model: NONEXISTENT_MODEL }))
  record(
    'failure: nonexistent model returns identifiable error',
    failure.status >= 400 && failure.body.includes('MODEL_NOT_FOUND'),
    `status=${failure.status} body=${failure.body.slice(0, 160)}`,
  )
  const pollutedKeys = await upstashKeys(`*${normalizeModelId(NONEXISTENT_MODEL)}*`)
  record(
    'failure: no cache pollution',
    pollutedKeys !== null && pollutedKeys.length === 0,
    JSON.stringify(pollutedKeys),
  )

  // 6. secret leak scan
  const leaked = []
  for (const secret of secretCandidates) {
    if (responseBodies.some((body) => body.includes(secret)) || serverLog.includes(secret)) {
      leaked.push(`${secret.slice(0, 4)}****`)
    }
  }
  record('security: no API key in responses or server logs', leaked.length === 0, leaked.join(','))

  // prod-only: cache hit via proxy on repeat call
  if (args.mode === 'prod' && !args['base-url']) {
    await summarize(baseVideoConfig({ model: modelA, showEmoji: true, outputLanguage: 'zh-CN', detailLevel: 600 }))
    await new Promise((r) => setTimeout(r, 1000))
    record('cache: repeat call hits proxy cache', /hit cache for/.test(serverLog))
  }

  if (serverProcess) {
    serverProcess.kill('SIGTERM')
  }
  writeFileSync(resolve(repoRoot, 'verify-kin44-server.log'), serverLog)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  if (serverProcess) {
    serverProcess.kill('SIGTERM')
  }
  process.exit(1)
})
