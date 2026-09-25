import { useEffect, useState } from 'react'

type OpenRouterModelOption = {
  id: string
  name: string
  created: number
  contextLength: number
  promptPrice: string
  completionPrice: string
}

type OpenRouterModelsPayload = {
  latestModel: OpenRouterModelOption | null
  defaultModel?: string
  source?: 'catalog' | 'fallback'
  fallbackReason?: string
  models: OpenRouterModelOption[]
}

export function useOpenRouterModels() {
  const [models, setModels] = useState<OpenRouterModelOption[]>([])
  const [latestModel, setLatestModel] = useState<OpenRouterModelOption | null>(null)
  const [defaultModel, setDefaultModel] = useState<string>('')
  const [source, setSource] = useState<'catalog' | 'fallback'>('catalog')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    async function fetchModels() {
      try {
        setLoading(true)
        setError(null)
        const response = await fetch('/api/openrouter/models', {
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        const payload = (await response.json()) as OpenRouterModelsPayload
        setModels(payload.models || [])
        setLatestModel(payload.latestModel || null)
        setDefaultModel(payload.defaultModel || '')
        setSource(payload.source || 'catalog')
      } catch (error: any) {
        if (error?.name === 'AbortError') {
          return
        }
        setError(error?.message || 'Failed to fetch models')
      } finally {
        setLoading(false)
      }
    }

    fetchModels().catch((error) => {
      setError(error?.message || 'Failed to fetch models')
      setLoading(false)
    })

    return () => {
      controller.abort()
    }
  }, [])

  return {
    models,
    latestModel,
    defaultModel,
    source,
    loading,
    error,
  }
}
