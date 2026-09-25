#!/usr/bin/env node
/**
 * KIN-44 unit contract fixtures for the pure registry/cache/error/catalog logic.
 *
 * Compiles utils/getCacheId.ts + lib/models/** with tsc into /tmp/kin44-unit-out,
 * rewrites the `~/` alias imports to relative paths, then runs assertions:
 *
 *   1. cache key includes provider/model/language/timestamp/emoji/bullets/
 *      outline/detail/promptVersion and changes when any of them switches
 *   2. cache key is stable for equivalent defaults (unset vs prompt defaults)
 *   3. legacy one-arg call still works (function compatibility)
 *   4. error classification maps auth/404/429/timeout/5xx/capability cases
 *   5. redactSecrets strips key-shaped tokens
 *   6. catalog filtering drops image/audio-only models, keeps text models
 *   7. fallback catalog always starts with the env default model
 */

import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const repoRoot = resolve(import.meta.dirname, '..')
const outDir = '/tmp/kin44-unit-out'

execFileSync(join(repoRoot, 'node_modules', '.bin', 'tsc'), ['-p', join(repoRoot, 'tsconfig.kin44-unit.json')], {
  stdio: 'inherit',
})

function patchAliasImports(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      patchAliasImports(full)
      continue
    }
    if (!entry.endsWith('.js')) {
      continue
    }
    let source = readFileSync(full, 'utf8')
    source = source.replace(/(['"])~\/([^'"]+)\1/g, (_, quote, target) => {
      const fromDir = dirname(full)
      let rel = relative(fromDir, join(outDir, target))
      if (!rel.startsWith('.')) {
        rel = `./${rel}`
      }
      return `${quote}${rel}${quote}`
    })
    writeFileSync(full, source)
  }
}
patchAliasImports(outDir)

const { getCacheId } = require('/tmp/kin44-unit-out/utils/getCacheId.js')
const {
  resolveModelTarget,
  resolveCacheIdContext,
  isLikelyThinkingModel,
  SUMMARY_CONFIG_VERSION,
} = require('/tmp/kin44-unit-out/lib/models/registry.js')
const { classifyUpstreamError, redactSecrets } = require('/tmp/kin44-unit-out/lib/models/errors.js')
const { isTextSummarizationModel, buildFallbackCatalog } = require('/tmp/kin44-unit-out/lib/models/catalog.js')

process.env.OPENAI_COMPATIBLE_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
process.env.OPENAI_COMPATIBLE_PROVIDER_NAME = 'zhipu-bigmodel'
process.env.OPENAI_COMPATIBLE_MODEL = 'glm-4.6'

const results = []
function record(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// 1. cache key composition & switching
const ctx = resolveCacheIdContext({})
const base = {
  videoId: 'BV1AL4y1j7RY',
  model: 'glm-4.6',
  outputLanguage: 'zh-CN',
  showTimestamp: false,
  showEmoji: true,
  sentenceNumber: 5,
  outlineLevel: 1,
  detailLevel: 600,
}
const baseKey = getCacheId(base, ctx)
const variants = {
  model: { ...base, model: 'glm-4.5-air' },
  language: { ...base, outputLanguage: 'en-US' },
  timestamp: { ...base, showTimestamp: true },
  emoji: { ...base, showEmoji: false },
  sentenceNumber: { ...base, sentenceNumber: 10 },
  outlineLevel: { ...base, outlineLevel: 3 },
  detailLevel: { ...base, detailLevel: 1000 },
  videoId: { ...base, videoId: 'DHhOgWPKIKU' },
}
for (const [name, config] of Object.entries(variants)) {
  const key = getCacheId(config, ctx)
  record(`cache key differs when ${name} switches`, key !== baseKey)
}
const otherProviderCtx = resolveCacheIdContext({ baseUrl: 'https://api.openai.com/v1' })
record(
  'cache key differs when provider/baseUrl switches',
  getCacheId(base, otherProviderCtx) !== baseKey,
  `${ctx.provider} vs ${otherProviderCtx.provider}`,
)
record('cache key contains prompt version', baseKey.includes(SUMMARY_CONFIG_VERSION), baseKey)

// 2. equivalent defaults collapse to the same key
record(
  'unset bullet/outline defaults match explicit defaults',
  getCacheId({ ...base, sentenceNumber: undefined, outlineLevel: undefined }, ctx) ===
    getCacheId({ ...base, sentenceNumber: 7, outlineLevel: 1 }, ctx),
)
record(
  'unset detailLevel differs from explicit 600 (prompt max_tokens/words differ)',
  getCacheId({ ...base, detailLevel: undefined }, ctx) !== baseKey,
)

// 3. legacy single-arg call still works
const legacyKey = getCacheId(base)
record('legacy getCacheId(config) call returns a key', typeof legacyKey === 'string' && legacyKey.length > 0, legacyKey)

// 4. error classification
const classificationCases = [
  [{ statusCode: 401, message: 'Invalid API key provided' }, 'UPSTREAM_AUTH'],
  [{ statusCode: 403, message: 'Forbidden' }, 'UPSTREAM_AUTH'],
  [{ statusCode: 404, message: 'The model glm-x does not exist' }, 'MODEL_NOT_FOUND'],
  [
    { statusCode: 400, message: 'Model not found', responseBody: '{"error":{"message":"no such model"}}' },
    'MODEL_NOT_FOUND',
  ],
  [{ statusCode: 400, message: '模型不存在，请检查模型代码。' }, 'MODEL_NOT_FOUND'],
  [
    {
      statusCode: 400,
      message:
        'upstream error (400): {"detail":"The \'bibigpt/kin44-nonexistent-model\' model is not supported when using Codex with a ChatGPT account."}',
    },
    'MODEL_NOT_FOUND',
  ],
  [{ statusCode: 429, message: 'Too many requests' }, 'RATE_LIMITED'],
  [{ name: 'AbortError', message: 'The operation was aborted' }, 'TIMEOUT'],
  [{ statusCode: 500, message: 'Internal Server Error' }, 'UPSTREAM_5XX'],
  [{ statusCode: 503, message: 'Service Unavailable' }, 'UPSTREAM_5XX'],
  [{ statusCode: 400, message: 'This model does not support image input modality' }, 'CAPABILITY_UNSUPPORTED'],
  [{ message: 'something odd' }, 'UNKNOWN'],
]
for (const [error, expected] of classificationCases) {
  const classified = classifyUpstreamError(error)
  record(`classify ${expected}`, classified.kind === expected, `got ${classified.kind}: ${classified.message}`)
}
record(
  'classified errors carry stable http statuses',
  classifyUpstreamError({ statusCode: 404, message: 'model not found' }).httpStatus === 400 &&
    classifyUpstreamError({ statusCode: 429, message: 'x' }).httpStatus === 429,
)

// 5. secret redaction
const secret = 'sk-abc123def456ghi789'
record(
  'redactSecrets removes key-shaped tokens',
  !redactSecrets(`failed with key ${secret} and Bearer eyJhb.9.x`).includes('abc123') &&
    redactSecrets(`Authorization: Bearer ${secret}`).includes('[REDACTED]'),
)
record(
  'classifyUpstreamError redacts secrets in messages',
  !classifyUpstreamError({ statusCode: 500, message: `upstream said ${secret} invalid` }).message.includes('abc123'),
)

// 6. catalog filtering
const catalogCases = [
  [{ id: 'a/gpt-4o', architecture: { modality: 'text->text' } }, true],
  [{ id: 'a/gpt-4o-vision', architecture: { modality: 'text+image->text' } }, true],
  [{ id: 'a/dall-e-3', architecture: { modality: 'text->image' } }, false],
  [{ id: 'a/whisper', architecture: { modality: 'audio->text' } }, false],
  [{ id: 'a/tts', architecture: { modality: 'text->audio' } }, false],
  [{ id: 'a/mixed', architecture: { input_modalities: ['text'], output_modalities: ['text'] } }, true],
  [{ id: 'a/image-out', architecture: { input_modalities: ['text'], output_modalities: ['image'] } }, false],
  [
    {
      id: 'a/gateway-capabilities',
      capabilities: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    },
    true,
  ],
  [{ id: 'a/gateway-asr', capabilities: { input_modalities: [], output_modalities: ['text'] } }, false],
  [{ id: 'mimo/mimo-v2.5-tts', capabilities: { output_modalities: ['text'] } }, false],
  [{ id: 'openai/gpt-image-1' }, false],
  [{ id: 'openai/text-embedding-3-large' }, false],
  [{ id: 'xai/grok-4.5' }, true],
  [{ id: 'deepseek/deepseek-flash' }, true],
  [{ id: 'a/legacy-no-arch' }, true],
]
for (const [model, expected] of catalogCases) {
  record(
    `catalog ${model.id} -> ${expected ? 'text-capable' : 'filtered out'}`,
    isTextSummarizationModel(model) === expected,
  )
}

// 7. fallback catalog
const fallback = buildFallbackCatalog('glm-4.6')
record('fallback catalog leads with env default', fallback[0]?.id === 'glm-4.6', fallback.map((m) => m.id).join(','))
record('fallback catalog has no duplicates', new Set(fallback.map((m) => m.id)).size === fallback.length)

// registry resolution
const target = resolveModelTarget({ model: ' glm-4.7 ', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/' })
record(
  'registry resolves model + trims + normalizes baseUrl',
  target.model === 'glm-4.7' && target.baseUrl === 'https://open.bigmodel.cn/api/paas/v4' && !target.isDefaultModel,
)
const defaultTarget = resolveModelTarget({})
record('registry falls back to env default model', defaultTarget.model === 'glm-4.6' && defaultTarget.isDefaultModel)

// thinking-model detection
const thinkingCases = [
  ['glm-4.6', true],
  ['glm-4.5-air', true],
  ['glm-5.3', true],
  ['o3-mini', true],
  ['deepseek/deepseek-reasoning', true],
  ['gpt-6-astra', false],
  ['gpt-4o-mini', false],
  ['deepseek/deepseek-flash', false],
]
for (const [modelId, expected] of thinkingCases) {
  record(`thinking detection ${modelId} -> ${expected}`, isLikelyThinkingModel(modelId) === expected)
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} unit checks passed`)
process.exit(failed.length ? 1 : 0)
