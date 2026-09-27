import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export function getFfprobeBin(): string {
  return process.env.BIBI_FFPROBE_PATH?.trim() || 'ffprobe'
}

export function getFfmpegBin(): string {
  return process.env.BIBI_FFMPEG_PATH?.trim() || 'ffmpeg'
}

export interface MediaProbeResult {
  /** false = 本机没有 ffprobe（或 BIBI_FFPROBE_PATH 不可执行） */
  ffprobeAvailable: boolean
  /** ffprobe 存在但对文件探测失败（损坏/伪容器） */
  probeFailed?: boolean
  container?: string
  /** 秒 */
  duration?: number
  hasAudio?: boolean
  hasVideo?: boolean
}

/** ffprobe 探测容器/时长/音视频轨；ffprobe 缺失时返回 available:false，由调用方决定降级策略 */
export async function probeMedia(filePath: string): Promise<MediaProbeResult> {
  let stdout: string
  try {
    const result = await execFileAsync(
      getFfprobeBin(),
      ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    )
    stdout = result.stdout
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return { ffprobeAvailable: false }
    }
    return { ffprobeAvailable: true, probeFailed: true }
  }

  let parsed: {
    format?: { format_name?: string; duration?: string }
    streams?: Array<{ codec_type?: string }>
  }
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { ffprobeAvailable: true, probeFailed: true }
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : []
  const duration = Number(parsed.format?.duration)
  return {
    ffprobeAvailable: true,
    container: parsed.format?.format_name,
    duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    hasVideo: streams.some((stream) => stream.codec_type === 'video'),
  }
}

/** FLV → MP4 无重编码 remux（修复 FLV 音画同步问题的统一容器步骤）；失败返回 false 不中断上传 */
export async function remuxFlvToMp4(srcPath: string, destPath: string): Promise<boolean> {
  try {
    await execFileAsync(
      getFfmpegBin(),
      ['-y', '-v', 'error', '-i', srcPath, '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', destPath],
      { timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 },
    )
    return true
  } catch {
    return false
  }
}

export interface ContainerSniff {
  container: 'flv' | 'mp4' | 'm4a' | 'mp3' | 'wav' | 'ogg' | 'flac' | 'webm' | 'subtitle' | 'unknown'
}

/** 魔数嗅探容器类型：路径永不来自文件名（fileId 绑定），容器判断以文件头为准 */
export async function sniffContainer(filePath: string): Promise<ContainerSniff> {
  const { open } = await import('node:fs/promises')
  const handle = await open(filePath, 'r')
  try {
    const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(16), position: 0 })
    const head = buffer.subarray(0, bytesRead)

    if (head.length >= 4 && head.subarray(0, 3).toString('latin1') === 'FLV') {
      return { container: 'flv' }
    }
    if (head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
      const brand = head.subarray(8, 12).toString('latin1')
      return { container: brand.startsWith('M4A') ? 'm4a' : 'mp4' }
    }
    if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'RIFF') {
      return { container: 'wav' }
    }
    if (head.length >= 3 && head.subarray(0, 3).toString('latin1') === 'ID3') {
      return { container: 'mp3' }
    }
    if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
      return { container: 'mp3' }
    }
    if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'OggS') {
      return { container: 'ogg' }
    }
    if (head.length >= 4 && head.subarray(0, 4).toString('latin1') === 'fLaC') {
      return { container: 'flac' }
    }
    if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
      return { container: 'webm' }
    }
    if (looksLikeText(head)) {
      return { container: 'subtitle' }
    }
    return { container: 'unknown' }
  } finally {
    await handle.close()
  }
}

function looksLikeText(head: Buffer): boolean {
  const sample = head.subarray(0, Math.min(head.length, 16))
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] === 0) {
      return false
    }
  }
  return sample.length > 0
}
