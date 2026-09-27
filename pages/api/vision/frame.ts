import { readFile } from 'node:fs/promises'

import type { NextApiRequest, NextApiResponse } from 'next'

import { requireUserId } from '~/lib/history/server'
import { resolveFrameFilePath } from '~/lib/vision/framesStore'
import { loadKeyframeArtifact } from '~/lib/vision/persist'

/**
 * GET /api/vision/frame?set=kfset_xxx&name=frame-000.jpg
 * 关键帧 JPEG 服务：set 必须属于当前用户已落库的 keyframes artifact，
 * 文件名白名单校验（只允许 frame-NNN.jpg），杜绝路径穿越与越权读取。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'method_not_allowed' })
  }
  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }
  const setId = typeof req.query.set === 'string' ? req.query.set : ''
  const fileName = typeof req.query.name === 'string' ? req.query.name : ''
  if (!setId || !fileName) {
    return res.status(400).json({ error: 'bad_request', message: 'missing set or name' })
  }

  try {
    // 越权防护：setId 必须出现在当前用户的某个 keyframes artifact 里
    const owned = await auth.supabase
      .from('artifacts')
      .select('id')
      .eq('user_id', auth.userId)
      .eq('kind', 'keyframes')
      .contains('refs', { setId })
      .limit(1)
      .maybeSingle()
    if (owned.error) {
      throw owned.error
    }
    if (!owned.data) {
      return res.status(404).json({ error: 'not_found', message: '关键帧集合不存在或不属于当前用户' })
    }

    const filePath = resolveFrameFilePath(setId, fileName)
    const bytes = await readFile(filePath)
    res.setHeader('Content-Type', 'image/jpeg')
    res.setHeader('Cache-Control', 'private, max-age=86400')
    return res.status(200).send(bytes)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return res.status(404).json({ error: 'not_found', message: '帧文件已不在磁盘，请重新生成关键帧' })
    }
    console.error('[vision] frame serve failed:', error)
    return res.status(500).json({ error: 'internal_error', message: error?.message ?? 'Internal Server Error' })
  }
}
