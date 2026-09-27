import type { NextApiRequest, NextApiResponse } from 'next'
import { ArtifactsError, generateArtifactsBundle } from '~/lib/artifacts/generate'
import { requireUserId } from '~/lib/history/server'

// 完整生成链路（读转录 → 拉源平台 → LLM → 落库）耗时较长，与 regenerate 同口径
export const config = { maxDuration: 300 }

type GenerateBody = {
  videoUrl?: string
  pageNumber?: string | null
  contentId?: string
  model?: string
  baseUrl?: string
  force?: boolean
}

/** POST /api/artifacts/generate：读 content+transcript → 调模型生成结构化 artifacts → 落库 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'method_not_allowed' })
  }

  const auth = await requireUserId(req, res)
  if (!auth) {
    return
  }

  const body = (req.body ?? {}) as GenerateBody
  if (!body.videoUrl && !body.contentId) {
    return res.status(400).json({ error: 'bad_request', message: 'missing videoUrl or contentId' })
  }
  if (body.videoUrl && typeof body.videoUrl !== 'string') {
    return res.status(400).json({ error: 'bad_request', message: 'videoUrl must be a string' })
  }

  try {
    const bundle = await generateArtifactsBundle({
      supabase: auth.supabase,
      userId: auth.userId,
      videoUrl: body.videoUrl ?? '',
      pageNumber: body.pageNumber ?? null,
      contentId: body.contentId ?? null,
      model: body.model,
      baseUrl: body.baseUrl,
      force: Boolean(body.force),
    })
    return res.status(200).json(bundle)
  } catch (error: any) {
    if (error instanceof ArtifactsError) {
      return res.status(error.statusCode).json({ error: error.code, message: error.message })
    }
    console.error('artifacts generation failed:', error)
    return res.status(500).json({ error: 'internal_error', message: error?.message ?? 'Internal Server Error' })
  }
}
