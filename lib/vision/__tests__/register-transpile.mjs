// KIN-48 测试用 load hook：所有 .ts 走 typescript transpile（覆盖 enum 与
// 非 import type 的纯类型导入，Node strip 模式会在这两类文件上炸 ESM link）。
// 配合 lib/sources/__fixtures__/register.mjs 的 ~/ @/ 别名 resolve hook 使用。
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file://') && url.endsWith('.ts')) {
      let source
      try {
        source = readFileSync(new URL(url), 'utf8')
      } catch {
        return nextLoad(url, context)
      }
      const transformed = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: url,
      })
      return { format: 'module', source: transformed.outputText, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
