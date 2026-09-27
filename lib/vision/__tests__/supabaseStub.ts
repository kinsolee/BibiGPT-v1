// 共享内存 Supabase 桩：只实现 vision 持久化/查询用到的链式接口。
import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, any>

interface QueryState {
  filters: Array<(row: Row) => boolean>
  orderCol?: string
  orderAsc: boolean
  limitN?: number
}

export function createSupabaseStub(): SupabaseClient {
  const rows: Array<Row & { table: string }> = []
  const makeBuilder = (table: string) => {
    const state: QueryState = { filters: [], orderAsc: true }
    const apply = (): Array<Row & { table: string }> => {
      const matched = rows.filter((row) => row.table === table && state.filters.every((fn) => fn(row)))
      if (state.orderCol) {
        const col: string = state.orderCol
        const asc = state.orderAsc
        matched.sort((a, b) => (asc ? a[col] - b[col] : b[col] - a[col]))
      }
      return state.limitN !== undefined ? matched.slice(0, state.limitN) : matched
    }
    const builder: any = {
      select() {
        return builder
      },
      eq(col: string, value: any) {
        state.filters.push((row) => row[col] === value)
        return builder
      },
      in(col: string, values: Array<any>) {
        state.filters.push((row) => values.includes(row[col]))
        return builder
      },
      contains(col: string, partial: Row) {
        state.filters.push((row) => Object.entries(partial).every(([key, value]) => (row[col] as Row)?.[key] === value))
        return builder
      },
      is(col: string, value: any) {
        state.filters.push((row) => (value === null ? row[col] === null || row[col] === undefined : row[col] === value))
        return builder
      },
      order(col: string, options?: { ascending?: boolean }) {
        state.orderCol = col
        state.orderAsc = options?.ascending !== false
        return builder
      },
      limit(n: number) {
        state.limitN = n
        return builder
      },
      maybeSingle: async () => ({ data: apply()[0] ?? null, error: null }),
      single: async () => ({ data: apply()[0], error: null }),
      then(resolve: any, reject: any) {
        return Promise.resolve({ data: apply(), error: null }).then(resolve, reject)
      },
      insert(payload: Row) {
        const row: Row & { table: string } = { ...payload, table }
        if (!row.id) {
          row.id = `id_${rows.length}`
        }
        if (!row.version) {
          row.version = 1
        }
        rows.push(row)
        return {
          select() {
            return {
              single: async () => ({ data: { version: row.version }, error: null }),
            }
          },
        }
      },
    }
    return builder
  }
  return {
    from: (table: string) => makeBuilder(table),
    // 测试播种：直接注入 contents 等既有行
    __seedRows(seed: Array<Row & { table?: string }>) {
      for (const row of seed) {
        rows.push({ table: 'contents', ...row } as Row & { table: string })
      }
    },
  } as unknown as SupabaseClient
}

export function makeContentRow(overrides?: Partial<Row>): Row {
  return {
    id: 'content-1',
    user_id: 'user-1',
    source_url: 'bibi-local:file/up_abc',
    service: 'local',
    source_ref: 'local:file:up_abc',
    source_page: null,
    title: 'test video',
    duration: 90,
    language: null,
    source_metadata: {},
    is_favorite: false,
    last_summarized_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}
