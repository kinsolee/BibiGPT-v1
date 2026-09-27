// VLM adapter 单测：fetch 注入 mock，不触网；校验结构化解析与错误传播。
import { check, checkEqual, resetSuite, summary } from './harness'
import { analyzeFrameImage, askFrameQuestion } from '../vlm'

const IMAGE = { base64: 'aGVsbG8=', mime: 'image/jpeg' }

function jsonResponse(text: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => ({ choices: [{ message: { content: text } }] }),
  } as unknown as Response
}

async function run() {
  resetSuite()
  console.log('vlm adapter (mocked fetch)')

  const calls: Array<{ url: string; body: any }> = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) })
    return jsonResponse('```json\n{"ocr":"标题文字","description":"一帧画面","tags":["a","b","a","c"]}\n```')
  }) as unknown as typeof fetch

  const result = await analyzeFrameImage(IMAGE, {
    model: 'test-vision-model',
    baseUrl: 'http://gateway.local/v1',
    apiKey: 'test-key',
    fetchImpl,
  })
  checkEqual('OCR 解析', result.ocr, '标题文字')
  checkEqual('描述解析', result.description, '一帧画面')
  checkEqual('标签去重', result.tags, ['a', 'b', 'c'])
  checkEqual('请求端点', calls[0].url, 'http://gateway.local/v1/chat/completions')
  checkEqual('请求模型', calls[0].body.model, 'test-vision-model')
  checkEqual(
    '图片以 data URL 传入',
    calls[0].body.messages[1].content[1].image_url.url,
    'data:image/jpeg;base64,aGVsbG8=',
  )
  checkEqual('系统提示要求只输出 JSON', calls[0].body.messages[0].content, '只输出 JSON。')

  const noFence = await analyzeFrameImage(IMAGE, {
    model: 'm',
    baseUrl: 'http://g/v1',
    fetchImpl: (async () => jsonResponse('{"ocr":"","description":"d","tags":[]}')) as unknown as typeof fetch,
  })
  checkEqual('无代码围栏 JSON 同样解析', noFence.description, 'd')

  const emptyTags = await analyzeFrameImage(IMAGE, {
    model: 'm',
    baseUrl: 'http://g/v1',
    fetchImpl: (async () => jsonResponse('{"ocr":"","description":"d"}')) as unknown as typeof fetch,
  })
  checkEqual('缺 tags 字段兜底空数组', emptyTags.tags, [])

  let refused = ''
  try {
    await analyzeFrameImage(IMAGE, {
      model: 'm',
      baseUrl: 'http://g/v1',
      fetchImpl: (async () => jsonResponse('内容安全策略拒绝回答')) as unknown as typeof fetch,
    })
  } catch (error) {
    refused = error instanceof Error ? error.message : ''
  }
  check('非 JSON 输出抛错（内容安全拒绝按帧错误隔离）', refused.includes('VLM 输出'), refused)

  let httpMessage = ''
  try {
    await analyzeFrameImage(IMAGE, {
      model: 'm',
      baseUrl: 'http://g/v1',
      fetchImpl: (async () => jsonResponse('upstream boom', 502)) as unknown as typeof fetch,
    })
  } catch (error) {
    httpMessage = error instanceof Error ? error.message : ''
  }
  check('HTTP 错误带状态码透出', httpMessage.includes('502'), httpMessage)

  const answer = await askFrameQuestion(IMAGE, '画面里有几个人？', {
    model: 'm',
    baseUrl: 'http://g/v1',
    fetchImpl: (async () => jsonResponse('{"answer":"两个人"}')) as unknown as typeof fetch,
  })
  checkEqual('frame Q&A 返回答案', answer, '两个人')

  summary('vlm')
}

export { run as runVlmTests }
