// ffmpeg 场景切分与关键帧抽帧（server-only）。
// 复用 lib/asr/prepare 的可用性探测与 lib/storage/mediaProbe 的时长探测（只读 import）。
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { isFfmpegAvailable } from '~/lib/asr/prepare'
import { getFfmpegBin, probeMedia } from '~/lib/storage/mediaProbe'
import { SourceError } from '~/lib/sources/types'

import { FRAME_FILE_PATTERN, ensureSetDir, resolveFrameFilePath } from './framesStore'
import { normalizeTime } from './keyframeSelect'

const execFileAsync = promisify(execFile)

export interface SceneDetectionResult {
  /** 升序去重后的场景切换时间（秒，毫秒粒度） */
  times: number[]
  duration: number | null
}

async function requireFfmpeg(): Promise<void> {
  if (!(await isFfmpegAvailable())) {
    throw new SourceError('SOURCE_UNAVAILABLE', '本机无可用 ffmpeg（BIBI_FFMPEG_PATH 可指定路径），无法做场景切分')
  }
}

/**
 * select='gt(scene,T)' + showinfo 从 stderr 解析场景切换时间戳。
 * 同一文件 + 同一阈值输出确定，是关键帧集合稳定性的来源。
 */
export async function detectSceneTimes(filePath: string, threshold: number): Promise<SceneDetectionResult> {
  await requireFfmpeg()
  const clamped = Math.min(1, Math.max(0, threshold))
  let stderr = ''
  try {
    const result = await execFileAsync(
      getFfmpegBin(),
      ['-y', '-v', 'info', '-i', filePath, '-vf', `select='gt(scene,${clamped})',showinfo`, '-an', '-f', 'null', '-'],
      { timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 },
    )
    stderr = result.stderr ?? ''
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new SourceError('SOURCE_UNAVAILABLE', '本机无可用 ffmpeg，无法做场景切分（BIBI_FFMPEG_PATH 可指定路径）')
    }
    throw new SourceError('SOURCE_UNAVAILABLE', `ffmpeg 场景切分失败：${truncate(error?.stderr ?? error?.message)}`)
  }

  const times = new Set<number>()
  const pattern = /pts_time:([0-9]+(?:\.[0-9]+)?)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(stderr)) !== null) {
    times.add(normalizeTime(Number(match[1])))
  }
  const probe = await probeMedia(filePath)
  return {
    times: Array.from(times).sort((a, b) => a - b),
    duration: probe.duration ?? null,
  }
}

/** 关键帧抽帧：按时间顺序写 frame-000.jpg 起；返回与 frames 目录对应的文件名列表 */
export async function extractFrameJpegs(
  filePath: string,
  times: number[],
  setId: string,
): Promise<Array<{ file: string; time: number }>> {
  await requireFfmpeg()
  const dir = await ensureSetDir(setId)
  const extracted: Array<{ file: string; time: number }> = []
  for (let idx = 0; idx < times.length; idx += 1) {
    const time = times[idx]
    const file = `frame-${String(idx).padStart(3, '0')}.jpg`
    const dest = path.join(dir, file)
    try {
      await execFileAsync(
        getFfmpegBin(),
        [
          '-y',
          '-v',
          'error',
          '-ss',
          time.toFixed(3),
          '-i',
          filePath,
          '-frames:v',
          '1',
          '-vf',
          "scale='min(640,iw)':-2",
          '-q:v',
          '3',
          dest,
        ],
        { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      )
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        throw new SourceError('SOURCE_UNAVAILABLE', '本机无可用 ffmpeg，无法抽取关键帧（BIBI_FFMPEG_PATH 可指定路径）')
      }
      throw new SourceError('SOURCE_UNAVAILABLE', `关键帧抽取失败（${file} @${time}s）：${truncate(error?.message)}`)
    }
    const info = await stat(dest)
    if (info.size === 0) {
      throw new SourceError('SOURCE_UNAVAILABLE', `关键帧输出为空（${file} @${time}s），已阻止生成空帧集合`)
    }
    extracted.push({ file, time })
  }
  return extracted
}

/** 读取帧 JPEG 字节（VLM base64 与内容 hash 用）；文件缺失抛可操作的 SourceError */
export async function readFrameBytes(setId: string, file: string): Promise<Buffer> {
  if (!FRAME_FILE_PATTERN.test(file)) {
    throw new SourceError('SOURCE_UNAVAILABLE', `非法帧文件引用: ${file}`)
  }
  const filePath = resolveFrameFilePath(setId, file)
  try {
    return await readFile(filePath)
  } catch {
    throw new SourceError('SOURCE_UNAVAILABLE', `帧文件已不在磁盘（${setId}/${file}），请重新生成关键帧`)
  }
}

function truncate(text: unknown, max = 300): string {
  const value = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}
