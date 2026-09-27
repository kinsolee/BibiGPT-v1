// 让 node 原生 TS 运行支持 ~/ @/ 别名与无后缀相对导入（仅 fixture 运行使用）
const ROOT = new URL('../../../', import.meta.url)
const HAS_EXTENSION = /\.[cm]?[jt]s$/

// 纯类型模块的整体 shim（KIN-46 同坑：type-only named import 在运行时报
// "does not provide an export named"）。lib/api fixture 链只用到类型。
const TYPE_ONLY_MODULES = new Set([new URL('lib/models/types.ts', ROOT).href])

export async function resolve(specifier, context, nextResolve) {
  const target =
    specifier.startsWith('~/') || specifier.startsWith('@/') ? new URL(specifier.slice(2), ROOT).href : specifier
  try {
    const resolved = await nextResolve(target, context)
    if (TYPE_ONLY_MODULES.has(resolved.url)) {
      return { url: resolved.url, shortCircuit: true, format: 'module-types-only' }
    }
    return resolved
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && !HAS_EXTENSION.test(target)) {
      return nextResolve(target + '.ts', context)
    }
    throw error
  }
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && TYPE_ONLY_MODULES.has(url)) {
    return {
      format: 'module',
      source:
        'export const ClassifiedUpstreamError = undefined\n' +
        'export const UpstreamErrorKind = undefined\n' +
        'export const UpstreamError = undefined\n',
      shortCircuit: true,
    }
  }
  return nextLoad(url, context)
}
