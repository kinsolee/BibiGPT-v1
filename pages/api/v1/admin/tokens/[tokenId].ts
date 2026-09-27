import type { NextApiRequest, NextApiResponse } from 'next'
import { getV1Deps } from '~/lib/api/deps'
import { handleV1AdminTokenRevoke } from '~/lib/api/handlers/adminTokens'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return handleV1AdminTokenRevoke(req, res, getV1Deps())
}
