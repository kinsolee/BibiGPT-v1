export interface TranscriptSegment {
  start: number
  end: number
  text: string
  lang?: string
  speaker?: string
  sourceRef?: string
}

export interface MediaImage {
  url: string
  alt?: string
  sourceRef?: string
}

export interface SourceChapter {
  title: string
  start: number
  end?: number
  sourceRef?: string
}

export interface MediaDocument {
  /** 回指原视频的规范引用，如 `youtube:video:{videoId}`、`bilibili:video:{videoId}:p{page}` */
  sourceRef: string
  sourceUrl: string
  service: string
  title: string
  duration?: number
  language?: string
  transcript: TranscriptSegment[]
  images?: MediaImage[]
  chapters?: SourceChapter[]
}

/** bilibili 旧链路需要 description 兜底；MediaDocument 契约不变，用扩展类型携带 */
export interface BilibiliMediaDocument extends MediaDocument {
  descriptionText?: string
}

export interface SourceAdapter {
  id: string
  match(url: URL): boolean
  fetch(url: string): Promise<MediaDocument>
}

export type SourceErrorCode = 'NO_TRANSCRIPT' | 'AUTH_REQUIRED' | 'SOURCE_UNAVAILABLE' | 'RATE_LIMITED'

export class SourceError extends Error {
  readonly code: SourceErrorCode

  constructor(code: SourceErrorCode, message: string) {
    super(message)
    this.name = 'SourceError'
    this.code = code
  }
}

export function sourceErrorCodeToHttpStatus(code: SourceErrorCode): number {
  switch (code) {
    case 'NO_TRANSCRIPT':
      return 501
    case 'AUTH_REQUIRED':
      return 403
    case 'SOURCE_UNAVAILABLE':
      return 502
    case 'RATE_LIMITED':
      return 429
  }
}
