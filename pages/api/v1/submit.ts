import type { NextApiRequest, NextApiResponse } from 'next'
import { getV1Deps } from '~/lib/api/deps'
import { handleV1Submit } from '~/lib/api/handlers/submit'
import { v1SubmitPipeline } from '~/lib/api/pipeline'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return handleV1Submit(req, res, getV1Deps(), v1SubmitPipeline)
}
