// KIN-47 IMA 知识库 provider：自用版仅保留 provider interface，投递返回结构化未实现错误。
import { ExportError } from '../errors'
import type { ExportSpec } from '../types'
import type { ExportProvider, ProviderContext } from './types'

async function notImplemented(_spec: ExportSpec, _ctx: ProviderContext): Promise<never> {
  throw new ExportError('not_implemented', 501, 'IMA 知识库导出尚未实现（自用版仅保留 provider interface）')
}

export const imaProvider: ExportProvider = {
  id: 'ima',
  displayName: 'IMA 知识库',
  kind: 'unimplemented',
  secretLabel: null,
  configFields: [],
  envConfigured: () => false,
  deliver: notImplemented,
}
