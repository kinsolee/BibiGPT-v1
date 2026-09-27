import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { transcribeAudioFile } from '~/lib/asr/whisper'

import { SourceError } from '../types'
import type { MediaDocument, MediaImage, SourceAdapter, TranscriptSegment } from '../types'

/** 常见播客 feed 主机名模式；其它域名可用 BIBI_PODCAST_EXTRA_HOSTS 追加 */
const FEED_HOST_PATTERN = /(^|\.)(feed|feeds|rss|rssfeed|feedproxy)\./i
const FEED_PATH_PATTERN = /\.(xml|rss)$/i

export function getExtraPodcastHosts(): string[] {
  return (process.env.BIBI_PODCAST_EXTRA_HOSTS || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function hostMatchesExtra(host: string, extra: string[]): boolean {
  return extra.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

/** 白名单：RSS/Atom 形态 URL（.xml/.rss 后缀、常见 feed 主机、env 追加），显式拒绝内网/云元数据地址 */
export function isPodcastFeedUrl(url: URL): boolean {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return false
  }
  const host = url.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    // 测试等场景可显式追加：BIBI_PODCAST_EXTRA_HOSTS
    return hostMatchesExtra(host, getExtraPodcastHosts())
  }
  if (FEED_PATH_PATTERN.test(url.pathname)) {
    return true
  }
  if (FEED_HOST_PATTERN.test(url.hostname)) {
    return true
  }
  return hostMatchesExtra(host, getExtraPodcastHosts())
}

export interface PodcastEpisode {
  title: string
  guid: string
  audioUrl?: string
  audioType?: string
  durationSeconds?: number
  image?: string
  publishedAt?: string
}

export interface ParsedFeed {
  showTitle: string
  showImage?: string
  episodes: PodcastEpisode[]
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function tagContent(block: string, tagName: string): string | undefined {
  const matched = block.match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, 'i'))
  if (!matched) {
    return undefined
  }
  const cdata = matched[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/)
  return decodeXmlEntities((cdata ? cdata[1] : matched[1]).trim())
}

function attributeContent(block: string, elementName: string, attribute: string): string | undefined {
  const matched = block.match(new RegExp(`<${elementName}(?:\\s[^>]*?)?\\s${attribute}="([^"]+)"`, 'i'))
  return matched ? decodeXmlEntities(matched[1]) : undefined
}

/** HH:MM:SS / MM:SS / 纯秒数 → 秒 */
export function parseItunesDuration(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined
  }
  const parts = raw.trim().split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part))) {
    return undefined
  }
  return parts.reduce((accumulator, part) => accumulator * 60 + part, 0)
}

const AUDIO_EXT_PATTERN = /\.(mp3|m4a|aac|ogg|opus|wav)(\?|$)/i

export function parsePodcastFeed(xml: string): ParsedFeed {
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/gi) ?? []
  const entryBlocks = itemBlocks.length ? [] : xml.match(/<entry[\s\S]*?<\/entry>/gi) ?? []
  const blocks = itemBlocks.length ? itemBlocks : entryBlocks

  const feedTitleTag = xml.match(/<channel[\s\S]*?<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i)
  const showTitle = feedTitleTag ? decodeXmlEntities(feedTitleTag[1].trim()) : 'podcast'
  const showImage =
    attributeContent(xml.split('<item')[0] ?? '', 'itunes:image', 'href') ||
    tagContent(xml.split('<item')[0] ?? '', 'image') ||
    undefined

  const episodes: PodcastEpisode[] = blocks.map((block, index) => {
    const enclosureUrl =
      attributeContent(block, 'enclosure', 'url') ||
      attributeContent(block.match(/<link[^>]*rel="enclosure"[^>]*>/i)?.[0] ?? '', 'link', 'href')
    const audioType = attributeContent(block, 'enclosure', 'type')
    return {
      title: tagContent(block, 'title') || `episode-${index + 1}`,
      guid: tagContent(block, 'guid') || tagContent(block, 'id') || `index-${index + 1}`,
      audioUrl: enclosureUrl,
      audioType,
      durationSeconds: parseItunesDuration(tagContent(block, 'itunes:duration')),
      image: attributeContent(block, 'itunes:image', 'href') || undefined,
      publishedAt: tagContent(block, 'pubDate') || tagContent(block, 'updated') || tagContent(block, 'published'),
    }
  })

  return { showTitle, showImage, episodes }
}

function episodeTimeoutMs(): number {
  const parsed = Number(process.env.BIBI_PODCAST_FETCH_TIMEOUT_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60_000
}

async function fetchWithLimit(url: string, label: string): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(episodeTimeoutMs()) })
  } catch (error: any) {
    if (error?.name === 'TimeoutError' || error?.code === 'ABORT_ERR') {
      throw new SourceError('SOURCE_UNAVAILABLE', `下载超时（${label}）: ${url}`)
    }
    throw new SourceError('SOURCE_UNAVAILABLE', `下载失败（${label}）: ${url}`)
  }
  if (!response.ok) {
    if (response.status === 429) {
      throw new SourceError('RATE_LIMITED', `来源限流 (429): ${url}`)
    }
    throw new SourceError('SOURCE_UNAVAILABLE', `来源返回 ${response.status}: ${url}`)
  }
  return response
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const buffer = await response.arrayBuffer()
  if (buffer.byteLength > maxBytes) {
    throw new SourceError('SOURCE_UNAVAILABLE', `内容超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB 上限`)
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
}

/** 下载音频到临时文件（流式，超限中止），返回路径与清理函数 */
async function downloadAudioToTemp(
  url: string,
  maxBytes: number,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const response = await fetchWithLimit(url, 'podcast 音频')
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new SourceError('SOURCE_UNAVAILABLE', `音频 ${(contentLength / 1024 / 1024).toFixed(0)}MB 超过下载上限`)
  }

  const hash = createHash('sha1').update(url).digest('hex').slice(0, 12)
  const workDir = path.join(tmpdir(), `bibi-podcast-${hash}`)
  await rm(workDir, { recursive: true, force: true })
  await mkdir(workDir, { recursive: true })
  const audioPath = path.join(workDir, 'audio.mp3')

  try {
    const nodeStream = Readable.fromWeb(response.body as any)
    let received = 0
    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > maxBytes) {
        nodeStream.destroy(new SourceError('SOURCE_UNAVAILABLE', '音频超过下载上限'))
      }
    })
    await pipeline(nodeStream, createWriteStream(audioPath))
  } catch (error) {
    await rm(workDir, { recursive: true, force: true })
    throw error
  }
  const info = await stat(audioPath)
  if (info.size === 0) {
    await rm(workDir, { recursive: true, force: true })
    throw new SourceError('NO_TRANSCRIPT', '音频下载为空')
  }
  return { path: audioPath, cleanup: () => rm(workDir, { recursive: true, force: true }) }
}

/** 选集：`?ep=` 为 1 起始序号或 guid 子串；缺省取第一条带音频的条目（RSS 一般最新在前） */
export function selectEpisode(feed: ParsedFeed, epParam: string | null): { episode: PodcastEpisode; index: number } {
  if (epParam) {
    const numeric = Number(epParam)
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= feed.episodes.length) {
      const index = numeric - 1
      return { episode: feed.episodes[index], index }
    }
    const found = feed.episodes.findIndex((episode) => episode.guid.includes(epParam))
    if (found >= 0) {
      return { episode: feed.episodes[found], index: found }
    }
    throw new SourceError('SOURCE_UNAVAILABLE', `?ep=${epParam} 没有匹配到 feed 中的条目`)
  }
  const index = feed.episodes.findIndex((episode) => episode.audioUrl)
  if (index < 0) {
    throw new SourceError('NO_TRANSCRIPT', 'feed 中没有任何带音频附件的条目（fail closed，不生成伪转写）')
  }
  return { episode: feed.episodes[index], index }
}

export function buildPodcastSourceRef(feedUrl: string, episode: PodcastEpisode): string {
  const feedHash = createHash('sha1').update(feedUrl).digest('hex').slice(0, 10)
  const guidHash = createHash('sha1').update(episode.guid).digest('hex').slice(0, 10)
  return `podcast:feed:${feedHash}:ep:${guidHash}`
}

export const podcastAdapter: SourceAdapter = {
  id: 'podcast',
  match(url: URL): boolean {
    return isPodcastFeedUrl(url)
  },
  async fetch(rawUrl: string): Promise<MediaDocument> {
    const url = new URL(rawUrl)
    if (!isPodcastFeedUrl(url)) {
      throw new SourceError('SOURCE_UNAVAILABLE', `URL 不在播客 feed 白名单内: ${rawUrl}`)
    }

    const feedResponse = await fetchWithLimit(url.toString(), 'RSS feed')
    const xml = await readBodyWithLimit(feedResponse, 10 * 1024 * 1024)
    const feed = parsePodcastFeed(xml)
    if (!feed.episodes.length) {
      throw new SourceError('SOURCE_UNAVAILABLE', 'RSS feed 中没有条目')
    }

    const { episode, index } = selectEpisode(feed, url.searchParams.get('ep'))
    if (!episode.audioUrl) {
      throw new SourceError('NO_TRANSCRIPT', `条目「${episode.title}」没有音频附件（fail closed，不生成伪转写）`)
    }

    const maxDownloadBytes = Number(process.env.BIBI_PODCAST_MAX_DOWNLOAD_BYTES) || 2 * 1024 * 1024 * 1024
    const audio = await downloadAudioToTemp(episode.audioUrl, maxDownloadBytes)
    try {
      const { transcript, language } = await transcribeAudioFile(audio.path, {
        filename: `${episode.title}.mp3`,
        language: process.env.BIBI_ASR_LANGUAGE?.trim() || undefined,
      })
      const segments: TranscriptSegment[] = transcript
      const images: MediaImage[] = []
      if (episode.image || feed.showImage) {
        images.push({ url: episode.image || feed.showImage!, alt: episode.title })
      }
      const lastEnd = segments[segments.length - 1]?.end
      return {
        sourceRef: buildPodcastSourceRef(url.toString(), episode),
        sourceUrl: rawUrl,
        service: 'podcast',
        title: episode.title,
        duration: episode.durationSeconds ?? (Number.isFinite(lastEnd) ? lastEnd : undefined),
        language,
        transcript: segments,
        images: images.length ? images : undefined,
      }
    } finally {
      await audio.cleanup()
    }
  },
}
