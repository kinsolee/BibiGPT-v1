// popup：采集当前窗口支持的视频 tab → 多选 → 加入 Watch Later（默认）。
// 「开始总结」是显式手动动作，导入路径从不调用 submit。

const SUPPORTED = {
  isYoutubeUrl(url) {
    if (!url.hostname.endsWith('youtube.com')) return false
    if (url.pathname === '/watch' && url.searchParams.get('v')) return true
    return /^\/shorts\/[\w-]+$/.test(url.pathname)
  },
  isBilibiliUrl(url) {
    return url.hostname.endsWith('bilibili.com') && /^\/video\/(av\d+|BV\w+|bv\w+)/.test(url.pathname)
  },
}

const state = { tabs: [], importedUrls: [] }

const $ = (id) => document.getElementById(id)

async function init() {
  const { apiBase, apiToken } = await chrome.storage.local.get(['apiBase', 'apiToken'])
  if (apiBase) $('api-base').value = apiBase
  if (apiToken) $('api-token').value = apiToken
  if (!apiBase || !apiToken) {
    $('settings').classList.remove('hidden')
  }
  await loadTabs()
}

async function loadTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true })
  const candidates = []
  for (const tab of tabs) {
    if (!tab.url) continue
    let url
    try {
      url = new URL(tab.url)
    } catch (error) {
      continue
    }
    const supported = SUPPORTED.isYoutubeUrl(url) || SUPPORTED.isBilibiliUrl(url)
    if (!supported) continue
    candidates.push({ tabId: tab.id, url: tab.url, title: tab.title || tab.url, canonicalUrl: tab.url })
  }
  // 优先用内容脚本回传的规范化 URL（去噪、保留 B 站分P）
  await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const response = await chrome.tabs.sendMessage(candidate.tabId, { type: 'BIBI_PING' })
        if (response && response.type === 'BIBI_VIDEO_INFO' && response.url) {
          candidate.canonicalUrl = response.url
          if (response.title) candidate.title = response.title
        }
      } catch (error) {
        // 内容脚本未注入（如刚打开未刷新）时退回 tab.url
      }
    }),
  )
  state.tabs = candidates
  renderTabs()
}

function renderTabs() {
  const list = $('tab-list')
  list.textContent = ''
  for (const candidate of state.tabs) {
    const li = document.createElement('li')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = true
    checkbox.dataset.url = candidate.canonicalUrl
    checkbox.addEventListener('change', updateImportedButton)
    const text = document.createElement('div')
    const title = document.createElement('div')
    title.className = 'tab-title'
    title.textContent = candidate.title
    title.title = candidate.title
    const url = document.createElement('div')
    url.className = 'tab-url'
    url.textContent = candidate.canonicalUrl
    text.appendChild(title)
    text.appendChild(url)
    li.appendChild(checkbox)
    li.appendChild(text)
    list.appendChild(li)
  }
  $('tab-count').textContent = `${state.tabs.length} 个视频 tab`
  updateImportedButton()
}

function selectedUrls() {
  return Array.from($('tab-list').querySelectorAll('input[type="checkbox"]:checked')).map((el) => el.dataset.url)
}

function updateImportedButton() {
  $('import-btn').disabled = selectedUrls().length === 0
  $('summarize-btn').disabled = state.importedUrls.length === 0
}

/** 结果区只走 textContent 渲染，避免任何 HTML 注入面 */
function setResult(spans) {
  const container = $('result')
  container.textContent = ''
  for (const span of spans) {
    const el = document.createElement('span')
    el.className = span.className
    el.textContent = span.text
    container.appendChild(el)
    container.appendChild(document.createElement('br'))
  }
}

$('toggle-settings').addEventListener('click', () => {
  $('settings').classList.toggle('hidden')
})

$('select-all').addEventListener('change', (event) => {
  for (const checkbox of $('tab-list').querySelectorAll('input[type="checkbox"]')) {
    checkbox.checked = event.target.checked
  }
  updateImportedButton()
})

$('save-settings').addEventListener('click', async () => {
  const base = $('api-base').value.trim().replace(/\/+$/, '')
  const token = $('api-token').value.trim()
  const status = (text, ok) => {
    $('settings-status').textContent = text
    $('settings-status').style.color = ok ? '#1a7f37' : '#cf222e'
  }
  let origin
  try {
    origin = new URL(base).origin
  } catch (error) {
    status('API 地址无效', false)
    return
  }
  if (!token) {
    status('请填写 Token', false)
    return
  }
  try {
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] })
    if (!granted) {
      status('未授予该域名访问权限', false)
      return
    }
  } catch (error) {
    status(`权限申请失败：${error}`, false)
    return
  }
  await chrome.storage.local.set({ apiBase: base, apiToken: token })
  status('已保存', true)
})

// 默认动作：仅导入，绝不触发摘要
$('import-btn').addEventListener('click', async () => {
  const urls = selectedUrls()
  if (!urls.length) return
  $('import-btn').disabled = true
  setResult([{ text: '导入中…', className: 'status' }])
  const response = await chrome.runtime.sendMessage({ type: 'BIBI_API_IMPORT', urls })
  $('import-btn').disabled = false
  if (!response) {
    setResult([{ text: '后台无响应', className: 'err' }])
    return
  }
  if (!response.ok) {
    const detail =
      response.error ||
      (response.data && response.data.error && response.data.error.message) ||
      `HTTP ${response.status}`
    setResult([{ text: `导入失败：${String(detail)}`, className: 'err' }])
    return
  }
  const { imported = [], duplicates = [] } = response.data || {}
  state.importedUrls = imported.map((item) => item.sourceUrl)
  updateImportedButton()
  const spans = [
    { text: `已加入 Watch Later ${imported.length} 条，重复 ${duplicates.length} 条；未自动总结。`, className: 'ok' },
  ]
  if (duplicates.length) {
    spans.push({ text: `重复：${duplicates.join('、')}`, className: 'status' })
  }
  setResult(spans)
})

// 显式手动动作：逐个 submit，返回 jobId 供轮询
$('summarize-btn').addEventListener('click', async () => {
  if (!state.importedUrls.length) return
  $('summarize-btn').disabled = true
  setResult([{ text: '提交摘要任务中…', className: 'status' }])
  const lines = []
  for (const url of state.importedUrls) {
    const response = await chrome.runtime.sendMessage({ type: 'BIBI_API_SUBMIT', url })
    if (response && response.ok && response.data && response.data.jobId) {
      lines.push({
        text: `✅ ${shortUrl(url)} → jobId ${response.data.jobId}${response.data.reused ? '（复用已有任务）' : ''}`,
        className: 'ok',
      })
    } else {
      const detail =
        response && (response.error || (response.data && response.data.error && response.data.error.message))
      lines.push({ text: `❌ ${shortUrl(url)} → ${String(detail || '提交失败')}`, className: 'err' })
    }
  }
  $('summarize-btn').disabled = false
  setResult(lines)
})

function shortUrl(url) {
  return url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)
}

init()
