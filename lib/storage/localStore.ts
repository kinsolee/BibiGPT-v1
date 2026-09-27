import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { probeMedia, remuxFlvToMp4, sniffContainer } from './mediaProbe'

/**
 * 本地大文件对象存储（自用版）：仓库外 gitignored 目录，fileId 绑定。
 * blob 路径永远由随机 fileId 派生，原始文件名只存 meta —— 同名文件不会串播。
 * 断点续传：客户端按 receivedBytes offset 续传，offset 不一致返回冲突与实际大小。
 */
export function getUploadRoot(): string {
  return path.resolve(process.env.BIBI_UPLOAD_DIR?.trim() || path.join(homedir(), '.bibigpt-uploads'))
}

export const MAX_CHUNK_BYTES = 16 * 1024 * 1024

export function getMaxUploadBytes(): number {
  const parsed = Number(process.env.BIBI_MAX_UPLOAD_BYTES)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4 * 1024 * 1024 * 1024
}

const FILE_ID_PATTERN = /^up_[0-9a-z]{24}$/

export function isValidFileId(fileId: string): boolean {
  return FILE_ID_PATTERN.test(fileId)
}

export function createFileId(): string {
  return `up_${randomBytes(12).toString('hex')}`
}

export type UploadKind = 'audio' | 'video' | 'subtitle' | 'unknown'
export type UploadStatus = 'pending' | 'completed' | 'aborted'

export interface UploadSessionMeta {
  fileId: string
  /** 原始文件名，仅展示/后缀提示用，绝不参与存储路径 */
  filename: string
  declaredSize: number
  contentType?: string
  createdAt: string
  updatedAt: string
  status: UploadStatus
  receivedBytes: number
  kind: UploadKind
  container?: string
  /** ffprobe 实测秒数 */
  duration?: number
  hasAudio?: boolean
  /** remux/探测过程的非致命备注 */
  notes?: string[]
  remuxedTo?: string
}

const SUBTITLE_EXTENSION = /\.(srt|vtt|ass|ssa)$/i
const AUDIO_EXTENSION = /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i
const VIDEO_EXTENSION = /\.(mp4|mov|mkv|webm|flv|avi|m4v|ts)$/i

export function buildLocalFileUrl(fileId: string): string {
  return `bibi-local:file/${fileId}`
}

export interface UploadSessionSummary {
  fileId: string
  receivedBytes: number
  declaredSize: number
  status: UploadStatus
  filename: string
  kind: UploadKind
  container?: string
  duration?: number
  hasAudio?: boolean
  notes?: string[]
}

function sessionDir(fileId: string): string {
  return path.join(getUploadRoot(), fileId)
}

function blobPath(fileId: string): string {
  return path.join(sessionDir(fileId), 'blob')
}

function metaPath(fileId: string): string {
  return path.join(sessionDir(fileId), 'meta.json')
}

async function readMeta(fileId: string): Promise<UploadSessionMeta | null> {
  try {
    return JSON.parse(await readFile(metaPath(fileId), 'utf8')) as UploadSessionMeta
  } catch {
    return null
  }
}

async function writeMeta(meta: UploadSessionMeta): Promise<void> {
  meta.updatedAt = new Date().toISOString()
  await writeFile(metaPath(meta.fileId), JSON.stringify(meta, null, 2), 'utf8')
}

function toSummary(meta: UploadSessionMeta): UploadSessionSummary {
  return {
    fileId: meta.fileId,
    receivedBytes: meta.receivedBytes,
    declaredSize: meta.declaredSize,
    status: meta.status,
    filename: meta.filename,
    kind: meta.kind,
    container: meta.container,
    duration: meta.duration,
    hasAudio: meta.hasAudio,
    notes: meta.notes,
  }
}

function sanitizeFilename(filename: string): string {
  const base = path.basename(String(filename || ''))
  return (base || 'upload.bin').slice(0, 255)
}

function classifyKind(filename: string, container: string): UploadKind {
  if (container === 'subtitle' || SUBTITLE_EXTENSION.test(filename)) {
    return 'subtitle'
  }
  if (container === 'flv' || VIDEO_EXTENSION.test(filename)) {
    return 'video'
  }
  if (
    container === 'mp3' ||
    container === 'm4a' ||
    container === 'wav' ||
    container === 'ogg' ||
    container === 'flac'
  ) {
    return 'audio'
  }
  if (AUDIO_EXTENSION.test(filename)) {
    return 'audio'
  }
  if (container === 'mp4' || container === 'webm') {
    return 'video'
  }
  return 'unknown'
}

export async function initUpload(input: {
  filename: string
  size: number
  contentType?: string
}): Promise<UploadSessionSummary> {
  const size = Number(input.size)
  if (!Number.isFinite(size) || size < 0) {
    throw new UploadStoreError(400, 'invalid size')
  }
  if (size > getMaxUploadBytes()) {
    throw new UploadStoreError(413, `file exceeds BIBI_MAX_UPLOAD_BYTES=${getMaxUploadBytes()}`)
  }

  const fileId = createFileId()
  await mkdir(sessionDir(fileId), { recursive: true })
  const now = new Date().toISOString()
  const meta: UploadSessionMeta = {
    fileId,
    filename: sanitizeFilename(input.filename),
    declaredSize: size,
    contentType: input.contentType,
    createdAt: now,
    updatedAt: now,
    status: 'pending',
    receivedBytes: 0,
    kind: 'unknown',
  }
  await writeMeta(meta)
  return toSummary(meta)
}

export async function getUploadSession(fileId: string): Promise<UploadSessionSummary | null> {
  if (!isValidFileId(fileId)) {
    return null
  }
  const meta = await readMeta(fileId)
  return meta ? toSummary(meta) : null
}

/** 续传入口：pending 会话回真实收到的字节数；其它状态照常返回供客户端判断 */
export async function getSessionReceivedBytes(fileId: string): Promise<number | null> {
  if (!isValidFileId(fileId)) {
    return null
  }
  try {
    const info = await stat(blobPath(fileId))
    return info.size
  } catch {
    const meta = await readMeta(fileId)
    return meta ? 0 : null
  }
}

export class UploadStoreError extends Error {
  readonly statusCode: number
  readonly receivedBytes?: number

  constructor(statusCode: number, message: string, receivedBytes?: number) {
    super(message)
    this.name = 'UploadStoreError'
    this.statusCode = statusCode
    this.receivedBytes = receivedBytes
  }
}

/**
 * per-fileId 串行锁：把「读 offset → 校验 → 追加 → 更新 meta」变成原子的
 * read-modify-write。否则两个同 offset 的并发 PUT 会同时读到相同 current
 * 值并双双 append，损坏 blob 且续传 offset 与文件内容错位。
 * （跨进程安全由 offset 协议兜底：不一致即 409，客户端按 receivedBytes 重同步。）
 */
const sessionLocks = new Map<string, Promise<unknown>>()

function withSessionLock<T>(fileId: string, fn: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(fileId) ?? Promise.resolve()
  const result = previous.then(fn, fn)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  void tail.then(() => {
    if (sessionLocks.get(fileId) === tail) {
      sessionLocks.delete(fileId)
    }
  })
  sessionLocks.set(fileId, tail)
  return result
}

export async function appendChunk(fileId: string, offset: number, data: Buffer): Promise<UploadSessionSummary> {
  return withSessionLock(fileId, () => appendChunkLocked(fileId, offset, data))
}

async function appendChunkLocked(fileId: string, offset: number, data: Buffer): Promise<UploadSessionSummary> {
  if (!isValidFileId(fileId)) {
    throw new UploadStoreError(400, `invalid fileId: ${fileId}`)
  }
  if (!Number.isFinite(offset) || offset < 0) {
    throw new UploadStoreError(400, 'invalid offset')
  }
  if (data.length === 0 || data.length > MAX_CHUNK_BYTES) {
    throw new UploadStoreError(400, `chunk size must be 1..${MAX_CHUNK_BYTES} bytes`)
  }
  const meta = await readMeta(fileId)
  if (!meta) {
    throw new UploadStoreError(404, `upload session not found: ${fileId}`)
  }
  if (meta.status !== 'pending') {
    throw new UploadStoreError(409, `upload session is ${meta.status}`, meta.receivedBytes)
  }

  const current = await getSessionReceivedBytes(fileId)
  if (current === null) {
    throw new UploadStoreError(404, `upload session not found: ${fileId}`)
  }
  if (offset !== current) {
    throw new UploadStoreError(409, `offset mismatch: have ${current}`, current)
  }
  if (current + data.length > meta.declaredSize) {
    throw new UploadStoreError(400, `chunk exceeds declared size ${meta.declaredSize}`, current)
  }
  await appendFile(blobPath(fileId), data)
  meta.receivedBytes = current + data.length
  await writeMeta(meta)
  return toSummary(meta)
}

export async function completeUpload(fileId: string): Promise<UploadSessionSummary> {
  if (!isValidFileId(fileId)) {
    throw new UploadStoreError(400, `invalid fileId: ${fileId}`)
  }
  return withSessionLock(fileId, () => completeUploadLocked(fileId))
}

async function completeUploadLocked(fileId: string): Promise<UploadSessionSummary> {
  const meta = await readMeta(fileId)
  if (!meta) {
    throw new UploadStoreError(404, `upload session not found: ${fileId}`)
  }
  if (meta.status === 'completed') {
    return toSummary(meta)
  }
  if (meta.status !== 'pending') {
    throw new UploadStoreError(409, `upload session is ${meta.status}`)
  }

  const current = await getSessionReceivedBytes(fileId)
  if (current !== meta.declaredSize) {
    throw new UploadStoreError(400, `incomplete upload: have ${current ?? 0} of ${meta.declaredSize}`, current ?? 0)
  }

  const notes: string[] = []
  const sniff = await sniffContainer(blobPath(fileId))
  const kind = classifyKind(meta.filename, sniff.container)
  meta.container = sniff.container
  meta.kind = kind
  meta.notes = notes

  if (sniff.container === 'flv') {
    // FLV 统一容器：无重编码 remux 成 MP4（fileId 绑定目录内原子替换），修复回放音画同步
    const remuxed = await remuxFlvToMp4(blobPath(fileId), `${blobPath(fileId)}.mp4`)
    if (remuxed) {
      await rm(blobPath(fileId))
      await import('node:fs/promises').then((fs) => fs.rename(`${blobPath(fileId)}.mp4`, blobPath(fileId)))
      meta.remuxedTo = 'mp4'
      meta.container = 'mp4'
      notes.push('flv remuxed to mp4')
    } else {
      notes.push('flv remux failed (ffmpeg missing or bad stream); kept original')
    }
  }

  const probe = await probeMedia(blobPath(fileId))
  if (!probe.ffprobeAvailable) {
    notes.push('ffprobe unavailable; duration/audio detection skipped')
  } else if (probe.probeFailed) {
    notes.push('ffprobe could not parse the file')
  } else {
    meta.duration = probe.duration
    meta.hasAudio = probe.hasAudio
  }

  meta.status = 'completed'
  await writeMeta(meta)
  return toSummary(meta)
}

export interface ResolvedUpload {
  path: string
  meta: UploadSessionMeta
}

/** adapter/ingest 使用：只接受 completed 会话；fileId 校验拦截路径穿越 */
export async function resolveCompletedUpload(fileId: string): Promise<ResolvedUpload | null> {
  if (!isValidFileId(fileId)) {
    return null
  }
  const meta = await readMeta(fileId)
  if (!meta || meta.status !== 'completed') {
    return null
  }
  return { path: blobPath(fileId), meta }
}

export async function abortUpload(fileId: string): Promise<boolean> {
  if (!isValidFileId(fileId)) {
    return false
  }
  const meta = await readMeta(fileId)
  if (!meta) {
    return false
  }
  await rm(sessionDir(fileId), { recursive: true, force: true })
  return true
}
