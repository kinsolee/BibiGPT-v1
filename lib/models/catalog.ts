import { getDefaultModelId } from '~/lib/models/registry'

export interface CatalogModelOption {
  id: string
  name: string
  created: number
  contextLength: number
  promptPrice: string
  completionPrice: string
}

export interface RawCatalogModel {
  id?: string
  name?: string
  created?: number
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
  architecture?: {
    modality?: string
    input_modalities?: string[]
    output_modalities?: string[]
  }
  capabilities?: {
    input_modalities?: string[]
    output_modalities?: string[]
  }
}

// Some catalogs (e.g. OpenAI-style gateways) omit input_modalities for
// audio/image-only models, so fall back to well-known id tokens.
const NON_TEXT_ID_PATTERN =
  /(?:^|[/_\-.])(tts|asr|stt|whisper|embed(?:ding)?|rerank|sora|veo|imagen|dall-e|flux|stable-diffusion|midjourney|image)(?:$|[/_\-.])/i

function isTextToTextModality(modality?: string) {
  if (!modality) {
    return true
  }
  const [input = '', output = ''] = modality.split('->')
  return input.includes('text') && output.includes('text')
}

function hasTextInputAndOutput(inputModalities?: string[], outputModalities?: string[]) {
  const hasInput = Array.isArray(inputModalities)
  const hasOutput = Array.isArray(outputModalities)
  if (!hasInput && !hasOutput) {
    return null
  }
  // Non-text output can never summarize, even when input metadata is missing.
  if (hasOutput && !outputModalities!.includes('text')) {
    return false
  }
  if (hasInput && hasOutput) {
    return inputModalities!.includes('text') && outputModalities!.includes('text')
  }
  // Text-capable output with unknown input metadata: keep, id heuristics
  // filter out known audio-only models whose catalogs omit input modalities.
  return null
}

export function isTextSummarizationModel(model: RawCatalogModel): boolean {
  if (NON_TEXT_ID_PATTERN.test(model.id || '')) {
    return false
  }
  for (const metadata of [model.architecture, model.capabilities]) {
    if (!metadata) {
      continue
    }
    const modalities = hasTextInputAndOutput(metadata.input_modalities, metadata.output_modalities)
    if (modalities !== null) {
      return modalities
    }
    if ('modality' in metadata) {
      return isTextToTextModality((metadata as { modality?: string }).modality)
    }
  }
  return true
}

export function toCatalogModelOption(model: RawCatalogModel): CatalogModelOption {
  return {
    id: model.id || '',
    name: model.name || model.id || '',
    created: model.created || 0,
    contextLength: model.context_length || 0,
    promptPrice: model.pricing?.prompt || '',
    completionPrice: model.pricing?.completion || '',
  }
}

const STABLE_FALLBACK_MODEL_IDS = ['gpt-4o-mini', 'gpt-4o', 'claude-3.5-haiku', 'deepseek-chat', 'glm-4.6']

export function buildFallbackCatalog(defaultModelId = getDefaultModelId()): CatalogModelOption[] {
  const ids = [defaultModelId, ...STABLE_FALLBACK_MODEL_IDS].filter(
    (id, index, all) => Boolean(id) && all.indexOf(id) === index,
  )
  return ids.map((id) => ({
    id,
    name: `${id}${id === defaultModelId ? '（默认）' : '（内置候选）'}`,
    created: 0,
    contextLength: 0,
    promptPrice: '',
    completionPrice: '',
  }))
}
