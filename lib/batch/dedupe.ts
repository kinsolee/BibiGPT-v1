import { BATCH_MAX_ITEMS } from './types'
import type { CanonicalBatchItem } from './types'

/**
 * 按出现顺序去重并截断到 BATCH_MAX_ITEMS。
 * duplicates = 重复项 + 超出上限被丢弃的项数。
 */
export function dedupeAndCapItems(items: CanonicalBatchItem[]): {
  items: CanonicalBatchItem[]
  duplicates: number
} {
  const seen = new Set<string>()
  const unique: CanonicalBatchItem[] = []
  for (const item of items) {
    if (seen.has(item.dedupeKey)) {
      continue
    }
    seen.add(item.dedupeKey)
    if (unique.length >= BATCH_MAX_ITEMS) {
      break
    }
    unique.push(item)
  }
  return { items: unique, duplicates: items.length - unique.length }
}
