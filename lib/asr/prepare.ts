import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { SourceError } from '~/lib/sources/types'

const execFileAsync = promisify(execFile)

import { getFfmpegBin, getFfprobeBin } from '~/lib/storage/mediaProbe'

/** OpenAI Whisper 单请求上限 25MB，留裕量 */
export const ASR_MAX_REQUEST_BYTES = 24 * 1024 * 1024
/** 超限音频按 10 分钟分段（mp3 64k 单段约 4.8MB） */
const SEGMENT_SECONDS = 600

export interface AsrAudioChunk {
  path: string
  /** 该段在原音频里的起始秒 */
  offsetSeconds: number
}

export interface PreparedAsrAudio {
  chunks: AsrAudioChunk[]
  /** 清理临时目录（原文件直传时不清除调用方文件） */
  cleanup: () => Promise<void>
}

/**
 * 真实探测 ffmpeg 可执行性：getFfmpegBin() 恒返回非空字符串，字面量
 * 'ffmpeg' 在无安装环境同样不可用；按二进制路径缓存探测结果（测试通过
 * BIBI_FFMPEG_PATH 切换路径时各自独立探测）。
 */
const ffmpegAvailability = new Map<string, Promise<boolean>>()

export function isFfmpegAvailable(): Promise<boolean> {
  const bin = getFfmpegBin()
  const cached = ffmpegAvailability.get(bin)
  if (cached) {
    return cached
  }
  const probe = execFileAsync(bin, ['-version'], { timeout: 10_000, maxBuffer: 1024 * 1024 })
    .then(() => true)
    .catch((error: any) => {
      // 二进制存在但 -version 异常退出仍视为可用；不存在/不可执行则不可用
      return !(error?.code === 'ENOENT' || error?.code === 'EACCES')
    })
  ffmpegAvailability.set(bin, probe)
  return probe
}

/**
 * 把任意音/视频文件准备成 ≤25MB 的可转写分段：
 * - 小文件原样直传；
 * - 超限文件经 ffmpeg 抽音轨（-vn）+ mp3 64k 分段，segment_list csv 提供精确起始秒；
 * - 无 ffmpeg 时 fail closed（SOURCE 级 NO_TRANSCRIPT，绝不做伪转写）。
 */
export async function prepareAudioChunks(filePath: string): Promise<PreparedAsrAudio> {
  const { stat } = await import('node:fs/promises')
  const info = await stat(filePath)
  if (info.size <= ASR_MAX_REQUEST_BYTES) {
    return { chunks: [{ path: filePath, offsetSeconds: 0 }], cleanup: async () => {} }
  }
  if (!(await isFfmpegAvailable())) {
    throw new SourceError(
      'NO_TRANSCRIPT',
      `音频 ${(info.size / 1024 / 1024).toFixed(
        1,
      )}MB 超过单次转写上限 24MB，且本机无可用 ffmpeg（BIBI_FFMPEG_PATH 可指定路径）可分段；请安装 ffmpeg 或换小文件`,
    )
  }

  const hash = createHash('sha1').update(filePath).digest('hex').slice(0, 12)
  const workDir = path.join(tmpdir(), `bibi-asr-${hash}`)
  await rm(workDir, { recursive: true, force: true })
  await mkdir(workDir, { recursive: true })

  try {
    // -vn 剥离视频轨；mono 16k mp3 64k 是 Whisper 友好的省带宽编码
    await execFileAsync(
      getFfmpegBin(),
      [
        '-y',
        '-v',
        'error',
        '-i',
        filePath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-codec:a',
        'libmp3lame',
        '-b:a',
        '64k',
        '-f',
        'segment',
        '-segment_time',
        String(SEGMENT_SECONDS),
        '-segment_list',
        path.join(workDir, 'list.csv'),
        '-segment_list_type',
        'csv',
        '-reset_timestamps',
        '1',
        path.join(workDir, 'chunk-%05d.mp3'),
      ],
      { timeout: 30 * 60_000, maxBuffer: 8 * 1024 * 1024 },
    )
  } catch (error: any) {
    await rm(workDir, { recursive: true, force: true })
    // 可用性探测与真实执行之间二进制可能消失，ENOENT 仍按可操作错误 fail closed
    if (error?.code === 'ENOENT') {
      throw new SourceError('NO_TRANSCRIPT', '本机无可用 ffmpeg，无法分段转写（BIBI_FFMPEG_PATH 可指定路径）')
    }
    throw error
  }

  try {
    const listCsv = await readFile(path.join(workDir, 'list.csv'), 'utf8')
    const starts = new Map<string, number>()
    for (const line of listCsv.split('\n')) {
      const [file, start] = line.trim().split(',')
      if (file && start) {
        starts.set(path.join(workDir, file.trim()), Number(start) || 0)
      }
    }

    const entries = (await readdir(workDir)).filter((name) => /^chunk-\d+\.mp3$/.test(name)).sort()
    if (!entries.length) {
      throw new SourceError('NO_TRANSCRIPT', 'ffmpeg 分段输出为空，无法转写')
    }
    const chunks: AsrAudioChunk[] = []
    for (const name of entries) {
      const fullPath = path.join(workDir, name)
      const segmentInfo = await stat(fullPath)
      if (segmentInfo.size > ASR_MAX_REQUEST_BYTES) {
        throw new SourceError('NO_TRANSCRIPT', `分段后仍超上限（${name}），请改用更小的音频`)
      }
      chunks.push({ path: fullPath, offsetSeconds: starts.get(fullPath) ?? chunks.length * SEGMENT_SECONDS })
    }
    return { chunks, cleanup: () => rm(workDir, { recursive: true, force: true }) }
  } catch (error) {
    await rm(workDir, { recursive: true, force: true })
    throw error
  }
}
