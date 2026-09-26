import type { NextApiResponse } from 'next'

export async function writeWebStreamToNodeResponse(
  stream: ReadableStream<Uint8Array<ArrayBufferLike>>,
  res: NextApiResponse,
): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value) {
        const chunk = Buffer.from(value)
        res.write(chunk)
        text += decoder.decode(value, { stream: true })
      }
    }
    text += decoder.decode()
    res.end()
  } catch (error) {
    // Headers/body were already sent; destroying the socket is the only way to
    // signal an abnormal end without touching response headers again.
    console.error('[summarize] response stream aborted:', error)
    res.destroy(error instanceof Error ? error : new Error(String(error)))
  } finally {
    reader.releaseLock()
  }
  return text
}
