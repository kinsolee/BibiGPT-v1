// 让 node 原生 TS 运行支持 ~/ @/ 别名与无后缀相对导入（仅 fixture 运行使用）
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
