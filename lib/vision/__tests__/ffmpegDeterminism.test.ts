// ffmpeg 关键帧端到端确定性单测（真实 ffmpeg，本机可用时执行）：
// 合成三段纯色视频（红/蓝/绿 各 2s），场景切换应稳定落在 2s/4s；
// 重复检测 + 重复抽帧得到完全一致的帧集合（id、时间）。
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { isFfmpegAvailable } from '~/lib/asr/prepare'
import { getFfmpegBin } from '~/lib/storage/mediaProbe'

import { check, checkEqual, resetSuite, summary } from './harness'
import { detectSceneTimes, extractFrameJpegs } from '../ffmpegScenes'
import { computeKeyframeSetId, selectKeyframes } from '../keyframeSelect'

const execFileAsync = promisify(execFile)

async function synthVideo(dir: string): Promise<string> {
  const dest = path.join(dir, 'synth.mp4')
  await execFileAsync(
    getFfmpegBin(),
    [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x240:d=2:r=15',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x240:d=2:r=15',
      '-f',
      'lavfi',
      '-i',
      'color=c=green:s=320x240:d=2:r=15',
      '-filter_complex',
      '[0:v][1:v][2:v]concat=n=3:v=1:a=0',
      '-pix_fmt',
      'yuv420p',
      dest,
    ],
    { timeout: 60_000 },
  )
  return dest
}

async function run() {
  resetSuite()
  console.log('ffmpeg keyframe determinism (real ffmpeg)')
  if (!(await isFfmpegAvailable())) {
    console.log('  SKIP - 本机无 ffmpeg，跳过端到端确定性用例（纯函数确定性用例已在 keyframeSelect 覆盖）')
    summary('ffmpeg')
    return
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'bibi-vision-e2e-'))
  const prevVisionDir = process.env.BIBI_VISION_DIR
  process.env.BIBI_VISION_DIR = path.join(workDir, 'frames-root')
  try {
    const videoPath = await synthVideo(workDir)

    const first = await detectSceneTimes(videoPath, 0.3)
    const second = await detectSceneTimes(videoPath, 0.3)
    checkEqual('场景检测重复运行稳定', second.times, first.times)
    check('检测到 ≥2 处场景切换', first.times.length >= 2, first.times)
    checkEqual('时长探测 6 秒', first.duration, 6)

    const setId = computeKeyframeSetId({
      sourceRef: 'local:file:up_synth',
      threshold: 0.3,
      maxFrames: 24,
      minGapSeconds: 1,
      duration: first.duration,
    })
    const runA = selectKeyframes(
      { sceneTimes: first.times, duration: first.duration, maxFrames: 24, minGapSeconds: 1 },
      setId,
    )
    const runB = selectKeyframes(
      { sceneTimes: second.times, duration: second.duration, maxFrames: 24, minGapSeconds: 1 },
      setId,
    )
    checkEqual('帧集合（id+time）两次生成完全一致', runB, runA)
    check(
      '帧集合包含起始帧',
      runA.some((frame) => frame.time === 0),
      runA,
    )

    const extractedA = await extractFrameJpegs(
      videoPath,
      runA.map((frame) => frame.time),
      setId,
    )
    const extractedB = await extractFrameJpegs(
      videoPath,
      runB.map((frame) => frame.time),
      setId,
    )
    checkEqual('抽帧文件名与时间两次一致', extractedB, extractedA)
    checkEqual('抽帧数量与帧集合一致', extractedA.length, runA.length)

    summary('ffmpeg')
  } finally {
    await rm(workDir, { recursive: true, force: true })
    if (prevVisionDir === undefined) {
      delete process.env.BIBI_VISION_DIR
    } else {
      process.env.BIBI_VISION_DIR = prevVisionDir
    }
  }
}

export { run as runFfmpegDeterminismTests }
