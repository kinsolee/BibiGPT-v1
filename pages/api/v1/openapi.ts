import type { NextApiRequest, NextApiResponse } from 'next'
import { v1OpenApiSpec } from '~/lib/api/openapi'
import { applyV1Cors, sendV1MethodNotAllowed } from '~/lib/api/http'

/** GET /api/v1/openapi — 机器可读契约（无鉴权，不含任何机密） */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (applyV1Cors(req, res)) {
    return
  }
  if (req.method !== 'GET') {
    sendV1MethodNotAllowed(res, 'GET')
    return
  }
  res.status(200).json(v1OpenApiSpec)
}
