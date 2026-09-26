import type { NextApiRequest, NextApiResponse } from 'next'

import {
  buildFallbackCatalog,
  isTextSummarizationModel,
  RawCatalogModel,
  toCatalogModelOption,
} from '~/lib/models/catalog'
import { getDefaultModelId } from '~/lib/models/registry'

type OpenRouterModelsResponse = {
  data?: RawCatalogModel[]
}

const DEFAULT_CATALOG_URL = 'https://openrouter.ai/api/v1/models'
const CATALOG_TIMEOUT_MS = 8000
const MODELS_LIMIT = Number(process.env.OPENROUTER_MODELS_LIMIT || 120)

function originOf(url: string) {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET')
    return res.status(405).json({ error: 'Method Not Allowed' })
  }

  const catalogUrl = process.env.MODEL_CATALOG_URL || DEFAULT_CATALOG_URL
  const defaultModel = getDefaultModelId()

  try {
    const headers: Record<string, string> = {
      'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000',
      'X-OpenRouter-Title': 'BibiGPT',
    }
    // Never send the provider API key to a third-party catalog host: attach it
    // only when explicitly overridden via MODEL_CATALOG_API_KEY, or when the
    // catalog endpoint shares the provider's origin (e.g. Zhipu /models).
    const catalogApiKey = process.env.MODEL_CATALOG_API_KEY?.trim()
    const providerApiKey = process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY
    const providerBaseUrl = process.env.OPENAI_COMPATIBLE_BASE_URL?.trim()
    if (catalogApiKey) {
      headers.Authorization = `Bearer ${catalogApiKey}`
    } else if (providerApiKey && providerBaseUrl && originOf(catalogUrl) === originOf(providerBaseUrl)) {
      headers.Authorization = `Bearer ${providerApiKey}`
    }
    const response = await fetch(catalogUrl, {
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      headers,
    })

    if (!response.ok) {
      const detail = await response.text()
      console.error(`model catalog ${catalogUrl} failed: ${response.status} ${detail.slice(0, 200)}`)
      return res.status(200).json(fallbackPayload(defaultModel, `catalog HTTP ${response.status}`))
    }

    const payload = (await response.json()) as OpenRouterModelsResponse
    const models = (payload.data || [])
      .filter((model) => Boolean(model?.id))
      .filter(isTextSummarizationModel)
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .slice(0, MODELS_LIMIT)
      .map(toCatalogModelOption)

    if (!models.length) {
      return res.status(200).json(fallbackPayload(defaultModel, 'catalog returned no text-capable models'))
    }

    const latestModel = models[0]
    const visibleModels = models.some((model) => model.id === defaultModel)
      ? models
      : [toCatalogModelOption({ id: defaultModel, name: `${defaultModel}（默认）` }), ...models]

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900')
    return res.status(200).json({
      updatedAt: new Date().toISOString(),
      source: 'catalog',
      defaultModel,
      latestModel,
      models: visibleModels,
    })
  } catch (error: any) {
    console.error(`model catalog ${catalogUrl} failed: ${error?.message || 'Unknown error'}`)
    return res.status(200).json(fallbackPayload(defaultModel, error?.message || 'catalog fetch failed'))
  }
}

function fallbackPayload(defaultModel: string, reason: string) {
  return {
    updatedAt: new Date().toISOString(),
    source: 'fallback',
    fallbackReason: reason,
    defaultModel,
    latestModel: null,
    models: buildFallbackCatalog(defaultModel),
  }
}
