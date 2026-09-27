// KIN-48 单测入口：node 直跑（无测试框架）。
// 运行：node --import ./lib/sources/__fixtures__/register.mjs \
//          --import ./lib/vision/__tests__/register-transpile.mjs \
//          lib/vision/__tests__/run.ts
import { hasFailures } from './harness'
import { runAnalyzeCacheTests } from './analyzeCache.test'
import { runFfmpegDeterminismTests } from './ffmpegDeterminism.test'
import { runKeyframeSelectTests } from './keyframeSelect.test'
import { runReviewFixesTests } from './reviewFixes.test'
import { runVlmTests } from './vlm.test'

async function main() {
  runKeyframeSelectTests()
  await runVlmTests()
  await runAnalyzeCacheTests()
  await runReviewFixesTests()
  await runFfmpegDeterminismTests()
  if (hasFailures()) {
    process.exitCode = 1
  }
}

void main()
