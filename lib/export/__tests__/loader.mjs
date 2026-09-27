// 让 node 原生 TS 运行支持 ~/ @/ 别名与无后缀相对导入（仅 KIN-47 测试运行使用）
const ROOT = new URL('../../../', import.meta.url)
const HAS_EXTENSION = /\.[cm]?[jt]s$/

export async function resolve(specifier, context, nextResolve) {
  const target =
    specifier.startsWith('~/') || specifier.startsWith('@/') ? new URL(specifier.slice(2), ROOT).href : specifier
  // lib/models/types.ts 是纯类型模块：换具名导出 shim，避免 ESM 链接期 "does not provide an export"
  if (target.endsWith('/lib/models/types')) {
    return { url: new URL('./shims/models-types.mjs', import.meta.url).href, shortCircuit: true }
  }
  try {
    return await nextResolve(target, context)
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && !HAS_EXTENSION.test(target)) {
      return await nextResolve(target + '.ts', context)
    }
    throw error
  }
}
