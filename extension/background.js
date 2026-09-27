// 后台 service worker：替 popup 执行 v1 API 调用（import/submit），
// popup 关闭后导入仍能完成。token 只存 chrome.storage.local（用户自建的可撤销
// v1 token，最小 scope），绝不存放任何服务端密钥。

async function getSettings() {
  const { apiBase, apiToken } = await chrome.storage.local.get(['apiBase', 'apiToken'])
  if (!apiBase || !apiToken) {
    throw new Error('请先在扩展设置中填写 API 地址与 Token')
  }
  return { apiBase: apiBase.replace(/\/+$/, ''), apiToken }
}

async function apiCall(path, { method = 'POST', body, idempotencyKey } = {}) {
  const { apiBase, apiToken } = await getSettings()
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  }
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey
  }
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = null
  try {
    data = await response.json()
  } catch (error) {
    data = null
  }
  return { status: response.status, ok: response.ok, data }
}

async function handleImport(urls) {
  // 导入绝不触发摘要：/api/v1/import 只登记 watch-later pending item
  return apiCall('/api/v1/import', {
    method: 'POST',
    body: { urls, target: 'watch-later' },
    idempotencyKey: `ext-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  })
}

async function handleSubmit(url, options) {
  // 手动开始的摘要：仅当用户在 popup 明确点击「开始总结」时触发
  return apiCall('/api/v1/submit', {
    method: 'POST',
    body: { sourceUrl: url, ...(options ? { options } : {}) },
  })
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return undefined
  }
  if (message.type === 'BIBI_API_IMPORT') {
    handleImport(message.urls || [])
      .then(sendResponse)
      .catch((error) => sendResponse({ status: 0, ok: false, error: String((error && error.message) || error) }))
    return true
  }
  if (message.type === 'BIBI_API_SUBMIT') {
    handleSubmit(message.url, message.options)
      .then(sendResponse)
      .catch((error) => sendResponse({ status: 0, ok: false, error: String((error && error.message) || error) }))
    return true
  }
  return undefined
})
