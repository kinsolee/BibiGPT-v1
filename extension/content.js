// 内容脚本：在支持的视频页响应 popup 的探测消息，回传规范化 URL 与标题。
// 规范化与 lib/sources/registry 的白名单口径一致（youtube watch/shorts、bilibili /video/，B 站保留 ?p= 分P）。

function canonicalYoutubeUrl(url) {
  const params = url.searchParams
  const v = params.get('v')
  if (url.pathname === '/watch' && v) {
    return `https://www.youtube.com/watch?v=${v}`
  }
  const shorts = url.pathname.match(/^\/shorts\/([\w-]+)$/)
  if (shorts) {
    return `https://www.youtube.com/watch?v=${shorts[1]}`
  }
  return null
}

function canonicalBilibiliUrl(url) {
  const matched = url.pathname.match(/^\/video\/(av\d+|BV\w+|bv\w+)/)
  if (!matched) {
    return null
  }
  const page = url.searchParams.get('p')
  const suffix = page && Number(page) > 1 ? `?p=${Number(page)}` : ''
  return `https://www.bilibili.com/video/${matched[1]}${suffix}`
}

function canonicalUrl() {
  try {
    const url = new URL(location.href)
    if (url.hostname.endsWith('youtube.com')) {
      return canonicalYoutubeUrl(url)
    }
    if (url.hostname.endsWith('bilibili.com')) {
      return canonicalBilibiliUrl(url)
    }
  } catch (error) {
    // ignore
  }
  return null
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'BIBI_PING') {
    const url = canonicalUrl()
    if (url) {
      sendResponse({ type: 'BIBI_VIDEO_INFO', url, title: document.title })
    } else {
      sendResponse({ type: 'BIBI_UNSUPPORTED' })
    }
  }
  return undefined
})
