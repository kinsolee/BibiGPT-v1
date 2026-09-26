#!/usr/bin/env node
/**
 * KIN-44 real-model verification through the same @ai-sdk/openai-compatible
 * stack the app uses in lib/openai/fetchOpenAIResult.ts.
 *
 * Usage: node scripts/verify-kin44-model.mjs
 * Reads provider config from .env (OPENAI_COMPATIBLE_*).
 *
 * Checks:
 *   1. non-stream generateText with the configured default model
 *   2. streamText with the configured default model (multiple chunks)
 *   3. model switch to --model-b (default glm-4.5-air) still works
 *   4. nonexistent model returns an identifiable model-not-found error
 *   5. no API key value appears in any logged error text
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const repoRoot = resolve(import.meta.dirname, '..')
const { createOpenAICompatible } = require('@ai-sdk/openai-compatible')
const { generateText, streamText } = require('ai')

function loadEnvFile(file) {
  const env = {}
  if (!existsSync(file)) {
    return env
  }
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/)
    if (!match || line.trim().startsWith('#')) {
      continue
    }
    env[match[1]] = match[2].replace(/^['"]|['"]$/g, '').replace(/\$\{(\w+)\}/g, (_, n) => env[n] ?? '')
  }
  return env
}

const fileEnv = loadEnvFile(resolve(repoRoot, '.env'))
const env = { ...process.env, ...fileEnv }

const BASE_URL = env.OPENAI_COMPATIBLE_BASE_URL || 'https://api.openai.com/v1'
const PROVIDER_NAME = env.OPENAI_COMPATIBLE_PROVIDER_NAME || 'openai-compatible'
const API_KEY = env.OPENAI_COMPATIBLE_API_KEY || env.OPENAI_API_KEY
const MODEL_A = env.OPENAI_COMPATIBLE_MODEL || 'gpt-4o-mini'
const MODEL_B = process.argv.includes('--model-b')
  ? process.argv[process.argv.indexOf('--model-b') + 1]
  : env.MODEL_B || 'glm-4.5-air'
const NONEXISTENT = 'bibigpt/kin44-nonexistent-model'

if (!API_KEY) {
  console.error('Missing OPENAI_COMPATIBLE_API_KEY in .env')
  process.exit(2)
}

const provider = createOpenAICompatible({ baseURL: BASE_URL, name: PROVIDER_NAME, apiKey: API_KEY })

const results = []
function record(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const PROMPT = `Summarize the following in 3 bullet points, reply in Chinese:
"The BibiGPT project adds a provider registry so that model selection, base URL and API key resolution all go through one module. Cache keys now include provider, model and every summary option, so switching any of them can never reuse another config's cached summary. Upstream errors are classified into stable kinds such as model-not-found, auth, rate-limit, timeout and 5xx."`

const logTexts = []
async function runNonStream(model) {
  const result = await generateText({
    model: provider.chatModel(model),
    prompt: PROMPT,
    // thinking models need generous output budget, small probes report false failures
    maxOutputTokens: 4000,
  })
  logTexts.push(result.text)
  return result.text
}

async function runStream(model) {
  const result = streamText({
    model: provider.chatModel(model),
    prompt: PROMPT,
    maxOutputTokens: 4000,
  })
  let text = ''
  let chunks = 0
  for await (const part of result.textStream) {
    chunks += 1
    text += part
  }
  logTexts.push(text)
  return { text, chunks }
}

async function main() {
  console.log(`provider=${PROVIDER_NAME} baseUrl=${BASE_URL} modelA=${MODEL_A} modelB=${MODEL_B}`)

  try {
    const text = await runNonStream(MODEL_A)
    record(
      `non-stream ${MODEL_A}: real call returns content`,
      text.trim().length > 30,
      `chars=${text.trim().length} head=${text.trim().slice(0, 60)}`,
    )
  } catch (error) {
    record(`non-stream ${MODEL_A}: real call returns content`, false, String(error?.message || error).slice(0, 200))
  }

  try {
    const { text, chunks } = await runStream(MODEL_A)
    record(
      `stream ${MODEL_A}: real call streams multiple chunks`,
      text.trim().length > 30 && chunks > 1,
      `chunks=${chunks} chars=${text.trim().length}`,
    )
  } catch (error) {
    record(`stream ${MODEL_A}: real call streams multiple chunks`, false, String(error?.message || error).slice(0, 200))
  }

  try {
    const text = await runNonStream(MODEL_B)
    record(
      `model switch to ${MODEL_B}: works`,
      text.trim().length > 30,
      `chars=${text.trim().length} head=${text.trim().slice(0, 60)}`,
    )
  } catch (error) {
    record(`model switch to ${MODEL_B}: works`, false, String(error?.message || error).slice(0, 200))
  }

  try {
    await runNonStream(NONEXISTENT)
    record('nonexistent model: fails with identifiable error', false, 'call unexpectedly succeeded')
  } catch (error) {
    const message = String(error?.message || error)
    const status = error?.statusCode ?? error?.status ?? 'n/a'
    const identifiable = /not exist|not found|no such|invalid|不存在|model/i.test(message)
    record(
      'nonexistent model: fails with identifiable error',
      identifiable,
      `statusCode=${status} ${message.slice(0, 160)}`,
    )
    logTexts.push(message)
  }

  const leaked = logTexts.some((text) => text.includes(API_KEY))
  record('security: no API key in logged outputs', !leaked)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} model checks passed`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
