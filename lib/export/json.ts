// KIN-47 JSON 渲染：直接序列化 ExportSpec（字段完整、含保留字段）。
import type { ExportSpec } from './types'

export function renderJson(spec: ExportSpec): string {
  return `${JSON.stringify(spec, null, 2)}\n`
}
