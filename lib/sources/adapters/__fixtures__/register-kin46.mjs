// KIN-46 专用 hook：Node strip-types 模式不支持 TS enum，而摘要链路
// （lib/types.ts VideoService、lib/openai/fetchOpenAIResult.ts ChatGPTAgent）
// 含 enum。这里对命中 enum 的 .ts 用仓库自带 typescript 做完整 transpile，
// 其余文件仍走 Node 原生 strip（与既有 register.mjs 共存）。
// 注意必须自己读文件：defaultLoad 对 .ts 的格式探测会先 parse 源码并直接
// 在 enum 上抛错，不能先调 nextLoad 再改写。
// 用法：--import ./lib/sources/__fixtures__/register.mjs --import ./register-kin46.mjs <entry>
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const ENUM_PATTERN = /\benum\s+[A-Za-z_$][\w$]*/

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file://') && url.endsWith('.ts')) {
      let source
      try {
        source = readFileSync(new URL(url), 'utf8')
      } catch {
        return nextLoad(url, context)
      }
      // 统一 transpile：除 enum 外，还把仅作类型使用的 import 做文件内消解
      // （Node strip 模式不消解非 import type 的纯类型导入，会炸 ESM link）
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
