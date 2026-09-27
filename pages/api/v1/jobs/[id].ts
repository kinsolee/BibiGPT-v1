import type { NextApiRequest, NextApiResponse } from 'next'
import { defaultV1JobReader } from '~/lib/api/jobReader'
import { getV1Deps } from '~/lib/api/deps'
import { handleV1JobsGet } from '~/lib/api/handlers/jobs'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return handleV1JobsGet(req, res, getV1Deps(), defaultV1JobReader)
}
