import type { NextApiRequest, NextApiResponse } from 'next'
import { createSupabaseContentReader } from '~/lib/api/contentReader'
import { getV1Deps } from '~/lib/api/deps'
import { handleV1ContentsGet } from '~/lib/api/handlers/contents'
import type { V1ContentReader } from '~/lib/api/handlers/contents'

/** Supabase 未配置时 auth 已在 handler 内先行 500；此桩仅兜底类型 */
const unavailableReader: V1ContentReader = {
  getContent: () => Promise.resolve(null),
  getLatestSummaryText: () => Promise.resolve(null),
  getTranscript: () => Promise.resolve({ lang: null, segments: [] }),
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const deps = getV1Deps()
  const reader = deps.supabase ? createSupabaseContentReader(deps.supabase) : unavailableReader
  return handleV1ContentsGet(req, res, deps, reader)
}
