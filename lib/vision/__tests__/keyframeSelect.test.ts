// 关键帧确定性单测：固定场景时间输入，重复选择与乱序输入必须得到同一帧集合。
import { check, checkEqual, resetSuite, summary } from './harness'
import {
  computeFrameId,
  computeKeyframeSetId,
  normalizeTime,
  selectKeyframes,
  selectKeyframeTimes,
} from '../keyframeSelect'

const SCENES = [3.456789, 12.0004, 0.5, 12.0, 45.123, 7.2, 30.999, 60.25]

function run() {
  resetSuite()
  console.log('keyframeSelect determinism')

  const first = selectKeyframeTimes({ sceneTimes: SCENES, duration: 90, maxFrames: 10, minGapSeconds: 2 })
  const repeated = selectKeyframeTimes({ sceneTimes: SCENES, duration: 90, maxFrames: 10, minGapSeconds: 2 })
  const shuffled = selectKeyframeTimes({
    sceneTimes: [...SCENES].reverse(),
    duration: 90,
    maxFrames: 10,
    minGapSeconds: 2,
  })
  checkEqual('重复运行结果稳定', repeated, first)
  checkEqual('输入乱序不影响结果', shuffled, first)

  check(
    '时间升序',
    first.every((time, idx) => idx === 0 || time > first[idx - 1]),
    first,
  )
  check(
    '毫秒粒度规范化',
    first.every((time) => Math.abs(time * 1000 - Math.round(time * 1000)) < 1e-6),
    first,
  )
  check(
    '最小间隔约束',
    first.every((time, idx) => idx === 0 || time - first[idx - 1] >= 2),
    first,
  )
  check('包含起始帧 0', first[0] === 0, first)
  checkEqual('规范化时间', normalizeTime(12.0004), 12.0)

  // 越界过滤
  const bounded = selectKeyframeTimes({ sceneTimes: [5, 95, 120], duration: 90, maxFrames: 10, minGapSeconds: 0 })
  checkEqual('超出时长的候选被过滤', bounded, [0, 5])

  // cap 截断（保最早）
  const capped = selectKeyframeTimes({
    sceneTimes: [1, 2, 3, 4, 5],
    duration: null,
    maxFrames: 3,
    minGapSeconds: 0,
  })
  checkEqual('超量截断保最早', capped, [0, 1, 2])

  // setId / frame id 稳定性
  const setIdInput = { sourceRef: 'local:file:up_abc', threshold: 0.3, maxFrames: 24, minGapSeconds: 2, duration: 90 }
  const setId = computeKeyframeSetId(setIdInput)
  check('setId 形如 kfset_+12hex', /^kfset_[0-9a-f]{12}$/.test(setId), setId)
  checkEqual('setId 重复计算稳定', computeKeyframeSetId(setIdInput), setId)
  check('阈值变化 setId 变化', computeKeyframeSetId({ ...setIdInput, threshold: 0.4 }) !== setId)

  const frames = selectKeyframes({ sceneTimes: SCENES, duration: 90, maxFrames: 10, minGapSeconds: 2 }, setId)
  const framesAgain = selectKeyframes({ sceneTimes: SCENES, duration: 90, maxFrames: 10, minGapSeconds: 2 }, setId)
  checkEqual('帧集合（id+time）重复运行稳定', framesAgain, frames)
  checkEqual(
    'frame id 与独立计算一致',
    frames.map((frame) => frame.id),
    frames.map((frame) => computeFrameId(setId, frame.time)),
  )
  check(
    '不同 setId 下 frame id 不同',
    frames.every((frame) => frame.id !== computeFrameId('kfset_000000000000', frame.time)),
  )

  summary('keyframeSelect')
}

export { run as runKeyframeSelectTests }
