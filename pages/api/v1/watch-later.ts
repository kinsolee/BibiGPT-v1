import type { NextApiRequest, NextApiResponse } from 'next'
import { createSupabaseWatchLaterReader } from '~/lib/api/watchLaterReader'
import { getV1Deps } from '~/lib/api/deps'
import { handleV1WatchLaterList } from '~/lib/api/handlers/watchlater'
import type { V1WatchLaterReader } from '~/lib/api/handlers/watchlater'

/** Supabase 未配置时 auth 已在 handler 内先行 500；此桩仅兜底类型 */
const unavailableReader: V1WatchLaterReader = {
  list: () =>
    Promise.resolve({
      items: [],
      nextCursor: null,
      collection: { id: '', title: '', batchStatus: 'idle' },
    }),
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const deps = getV1Deps()
  const reader = deps.supabase ? createSupabaseWatchLaterReader(deps.supabase) : unavailableReader
  return handleV1WatchLaterList(req, res, deps, reader)
}
