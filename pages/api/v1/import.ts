import type { NextApiRequest, NextApiResponse } from 'next'
import { defaultV1Importer } from '~/lib/api/importer'
import { getV1Deps } from '~/lib/api/deps'
import { handleV1Import } from '~/lib/api/handlers/import'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  return handleV1Import(req, res, getV1Deps(), defaultV1Importer)
}
