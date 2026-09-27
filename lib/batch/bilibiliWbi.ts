import { createHash } from 'crypto'
import { BatchError } from './types'

/**
 * Bilibili Wbi 签名：fav 资源列表等接口要求 wts + w_rid 参数。
 * 算法来源 bilibili-API-collect 社区文档（稳定口径）；nav 接口匿名可取 key，
 * key 每日轮换，这里缓存 12 小时。
 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
]

const NAV_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
}

const WBI_TTL_MS = 12 * 60 * 60 * 1000

let cachedKeys: { imgKey: string; subKey: string; fetchedAt: number } | null = null

function keyFromUrl(url: string): string {
  const file = url.split('/').pop() ?? ''
  return file.split('.')[0] ?? ''
}

async function getWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
  if (cachedKeys && Date.now() - cachedKeys.fetchedAt < WBI_TTL_MS) {
    return { imgKey: cachedKeys.imgKey, subKey: cachedKeys.subKey }
  }
  let imgKey = ''
  let subKey = ''
  try {
    // 匿名请求 code 为 -101，但 data.wbi_img 仍然返回
    const response = await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: NAV_HEADERS })
    const payload = (await response.json()) as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } }
    imgKey = payload.data?.wbi_img?.img_url ? keyFromUrl(payload.data.wbi_img.img_url) : ''
    subKey = payload.data?.wbi_img?.sub_url ? keyFromUrl(payload.data.wbi_img.sub_url) : ''
  } catch {
    // 落到下方统一报错
  }
  if (!imgKey || !subKey) {
    throw new BatchError('PARSE_FAILED', '无法获取哔哩哔哩 Wbi 签名参数（nav 接口不可用），请稍后重试')
  }
  cachedKeys = { imgKey, subKey, fetchedAt: Date.now() }
  return { imgKey, subKey }
}

function getMixinKey(original: string): string {
  return MIXIN_KEY_ENC_TAB.map((index) => original[index] ?? '')
    .join('')
    .slice(0, 32)
}

/** RFC3986 编码（!'()* 也要转义）后按 key 排序拼接，附 w_rid */
function signParams(params: Record<string, string | number>, mixinKey: string): string {
  const wts = Math.floor(Date.now() / 1000)
  const merged: Record<string, string | number> = { ...params, wts }
  const query = Object.keys(merged)
    .sort()
    .map((key) => {
      const value = encodeURIComponent(String(merged[key])).replace(/[!'()*]/g, (c) => {
        const hex = c.charCodeAt(0).toString(16).toUpperCase()
        return `%${hex.length === 1 ? `0${hex}` : hex}`
      })
      return `${encodeURIComponent(key)}=${value}`
    })
    .join('&')
  const wRid = createHash('md5')
    .update(query + mixinKey, 'utf8')
    .digest('hex')
  return `${query}&w_rid=${wRid}`
}

/** 构造带 Wbi 签名的完整请求 URL */
export async function buildSignedBilibiliUrl(
  endpoint: string,
  params: Record<string, string | number>,
): Promise<string> {
  const { imgKey, subKey } = await getWbiKeys()
  const mixinKey = getMixinKey(imgKey + subKey)
  return `https://api.bilibili.com${endpoint}?${signParams(params, mixinKey)}`
}
