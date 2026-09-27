// 关键帧 JPEG 的磁盘存放：~/.bibigpt-vision/sets/{setId}/frame-NNN.jpg。
// setId/文件名白名单校验，杜绝路径穿越；BIBI_VISION_DIR 可换根目录。
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const FRAME_FILE_PATTERN = /^frame-\d{3}\.jpg$/
export const SET_ID_PATTERN = /^kfset_[0-9a-f]{12}$/

export function getVisionRoot(): string {
  return path.resolve(process.env.BIBI_VISION_DIR?.trim() || path.join(homedir(), '.bibigpt-vision'))
}

export function isValidateSetId(setId: string): boolean {
  return SET_ID_PATTERN.test(setId)
}

export function keyframeSetDir(setId: string): string {
  if (!isValidateSetId(setId)) {
    throw new Error(`invalid keyframe setId: ${setId}`)
  }
  return path.join(getVisionRoot(), 'sets', setId)
}

export async function ensureSetDir(setId: string): Promise<string> {
  const dir = keyframeSetDir(setId)
  await mkdir(dir, { recursive: true })
  return dir
}

/** 白名单拼路径：只接受 frame-NNN.jpg，任意 ../ 与子目录都被拒绝 */
export function resolveFrameFilePath(setId: string, fileName: string): string {
  if (!isValidateSetId(setId) || !FRAME_FILE_PATTERN.test(fileName)) {
    throw new Error(`invalid keyframe file reference: ${setId}/${fileName}`)
  }
  return path.join(keyframeSetDir(setId), fileName)
}
