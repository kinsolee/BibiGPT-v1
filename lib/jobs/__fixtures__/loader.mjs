// 让 node 原生 TS 运行支持 ~/ @/ 别名与无后缀相对导入，并用项目自带的 typescript
// 把 .ts 转译为 JS（node strip-only 不支持 enum/参数属性，且无法消除 type-only 命名导入）。
// 运行方式：
//   node --import ./lib/jobs/__fixtures__/register.mjs ./lib/jobs/__fixtures__/run.mjs
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const ROOT = new URL('../../../', import.meta.url)
const HAS_EXTENSION = /\.[cm]?[jt]s$/

export async function resolve(specifier, context, nextResolve) {
  const target =
    specifier.startsWith('~/') || specifier.startsWith('@/') ? new URL(specifier.slice(2), ROOT).href : specifier
  try {
    return await nextResolve(target, context)
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && !HAS_EXTENSION.test(target)) {
      return nextResolve(target + '.ts', context)
    }
    throw error
  }
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith('file:') || !url.endsWith('.ts')) {
    return nextLoad(url, context)
  }
  const source = readFileSync(new URL(url), 'utf8')
  const { outputText } = ts.transpileModule(source, {
    fileName: url,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  })
  return { format: 'module', shortCircuit: true, source: outputText }
}
