import type { NextApiRequest, NextApiResponse } from 'next'

import {
  MAX_CHUNK_BYTES,
  UploadStoreError,
  appendChunk,
  completeUpload,
  getUploadSession,
  initUpload,
} from '~/lib/storage/localStore'
import { requireUploadAuth } from '~/lib/storage/uploadAuth'

export const config = {
  api: {
    // 原始分片直读流（PUT），JSON 动作手动读 body 并限幅
    bodyParser: false,
  },
}

const MAX_JSON_BODY_BYTES = 1024 * 1024

function readRawBody(req: NextApiRequest, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    req.on('data', (chunk: Buffer) => {
      received += chunk.length
      if (received > maxBytes) {
        reject(new UploadStoreError(413, `body exceeds ${(maxBytes / 1024 / 1024).toFixed(0)}MB`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJsonBody(req: NextApiRequest): Promise<any> {
  const raw = await readRawBody(req, MAX_JSON_BODY_BYTES)
  if (!raw.length) {
    return {}
  }
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    throw new UploadStoreError(400, 'invalid JSON body')
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!requireUploadAuth(req, res)) {
    return
  }

  try {
    if (req.method === 'GET') {
      const fileId = String(req.query.fileId ?? '')
      const session = await getUploadSession(fileId)
      if (!session) {
        return res.status(404).json({ errorMessage: `upload session not found: ${fileId}` })
      }
      return res.status(200).json(session)
    }

    if (req.method === 'PUT') {
      // 断点续传分片：PUT /api/upload?fileId=...&offset=...（raw octet-stream）
      const fileId = String(req.query.fileId ?? '')
      const offset = Number(req.query.offset)
      if (!fileId || !Number.isFinite(offset)) {
        return res.status(400).json({ errorMessage: 'Missing fileId or offset query' })
      }
      const body = await readRawBody(req, MAX_CHUNK_BYTES)
      const session = await appendChunk(fileId, offset, body)
      return res.status(200).json(session)
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      if (body.action === 'init') {
        if (!body.filename || !Number.isFinite(Number(body.size))) {
          return res.status(400).json({ errorMessage: 'init requires filename and size' })
        }
        const session = await initUpload({
          filename: String(body.filename),
          size: Number(body.size),
          contentType: body.contentType ? String(body.contentType) : undefined,
        })
        return res.status(200).json(session)
      }
      if (body.action === 'complete') {
        if (!body.fileId) {
          return res.status(400).json({ errorMessage: 'complete requires fileId' })
        }
        const session = await completeUpload(String(body.fileId))
        return res.status(200).json(session)
      }
      return res.status(400).json({ errorMessage: `Unknown action: ${body.action ?? '(none)'}` })
    }

    res.setHeader('Allow', 'GET, POST, PUT')
    return res.status(405).json({ errorMessage: 'Method Not Allowed' })
  } catch (error: any) {
    if (error instanceof UploadStoreError) {
      const payload: Record<string, unknown> = { errorMessage: error.message }
      if (error.receivedBytes !== undefined) {
        payload.receivedBytes = error.receivedBytes
      }
      return res.status(error.statusCode).json(payload)
    }
    console.error(`[upload] request failed: ${error?.message}`)
    return res.status(500).json({ errorMessage: 'upload request failed' })
  }
}
