import { douyinAdapter } from './douyin'
import { kuaishouAdapter } from './kuaishou'
import { localFileAdapter } from './localFile'
import { podcastAdapter } from './podcast'
import { wechatAdapter } from './wechat'
import { xiaohongshuAdapter } from './xiaohongshu'
import { youtubeAsrAdapter } from './youtubeAsr'
import type { SourceAdapter } from '../types'

/**
 * KIN-46 完整扩展面白名单（server-only）：
 * localFile/podcast/youtubeAsr 依赖 node:fs、node:child_process（ffmpeg/yt-dlp），
 * 必须与 lib/sources/registry.ts 分开注册，否则静态进入客户端 bundle 会让
 * webpack 拒绝 node: 内建模块。ingest 管线（pages/api/upload/ingest）专用，
 * /api/sumup 旧主流程不受影响。
 */
export const extendedSourceAdapters: SourceAdapter[] = [
  youtubeAsrAdapter,
  localFileAdapter,
  podcastAdapter,
  douyinAdapter,
  kuaishouAdapter,
  xiaohongshuAdapter,
  wechatAdapter,
]

/**
 * 扩展面 adapter 查找：在 http(s) 白名单之外额外接受 `bibi-local:file/{fileId}`
 * 内部协议（fileId 绑定的本地上传），其余协议（file:/data: 等）一律拒绝。
 */
export function findExtendedSourceAdapter(rawUrl: string): SourceAdapter | undefined {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'bibi-local:') {
    return undefined
  }
  return extendedSourceAdapters.find((adapter) => adapter.match(url))
}
