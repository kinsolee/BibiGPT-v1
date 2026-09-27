import { useCallback, useEffect, useState } from 'react'
import {
  ExportApiError,
  deliverExportApi,
  fetchExportDeliveries,
  fetchExportIntegrations,
  renderExportApi,
  retryExportDelivery,
  revokeExportIntegration,
  saveExportIntegration,
} from '~/lib/export/client'
import type { ExportDeliveryDTO, ExportIntegrationDTO, ExportProviderMeta } from '~/lib/export/types'
import { useToast } from '~/hooks/use-toast'

const FORMATS: Array<{ format: string; label: string }> = [
  { format: 'markdown', label: 'Markdown' },
  { format: 'json', label: 'JSON' },
  { format: 'pdf', label: 'PDF' },
  { format: 'docx', label: 'DOCX' },
]

const LEGACY_LOCALSTORAGE_KEYS: Record<string, string> = {
  flomo: 'user-flomo-webhook',
  lark_webhook: 'user-lark-webhook',
}

/**
 * 读取 legacy 集成配置：useLocalStorage 写入时做了 JSON.stringify，
 * 存储值形如 '"https://flomoapp.com/iwh/..."'（带引号字面量），需先 JSON.parse；
 * 历史上可能存在未经编码的裸值，解析失败时按原文回落。
 */
function readLegacyWebhookValue(storageKey: string): string | null {
  const raw = window.localStorage.getItem(storageKey)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'string' && parsed.trim()) {
      return parsed.trim()
    }
    return null
  } catch {
    const bare = raw.trim()
    return bare || null
  }
}

function integrationOf(integrations: ExportIntegrationDTO[], provider: string): ExportIntegrationDTO | null {
  return integrations.find((item) => item.provider === provider) ?? null
}

/**
 * 摘要结果下方的统一导出面板：Markdown/JSON/PDF/DOCX 下载（服务端签名链接）+
 * 第三方集成（flomo/飞书 Webhook 服务端加密、Notion/飞书文档走 env、IMA/Email 预留）。
 * 只读既有 summary/artifact，导出绝不触发生成。
 */
export function ExportPanel({ currentVideoUrl }: { currentVideoUrl: string }) {
  const { toast } = useToast()
  const [integrations, setIntegrations] = useState<ExportIntegrationDTO[]>([])
  const [providers, setProviders] = useState<ExportProviderMeta[]>([])
  const [deliveries, setDeliveries] = useState<ExportDeliveryDTO[]>([])
  const [loaded, setLoaded] = useState(false)
  const [needsAuth, setNeedsAuth] = useState(false)
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [migratable, setMigratable] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    if (!currentVideoUrl) {
      return
    }
    let cancelled = false
    setLoaded(false)
    fetchExportIntegrations()
      .then((response) => {
        if (cancelled) {
          return
        }
        setIntegrations(response.integrations)
        setProviders(response.providers)
        setLoaded(true)
      })
      .catch((fetchError: unknown) => {
        if (cancelled) {
          return
        }
        setLoaded(true)
        if (fetchError instanceof ExportApiError && fetchError.status === 401) {
          setNeedsAuth(true)
        }
      })
    fetchExportDeliveries({ videoUrl: currentVideoUrl, limit: 5 })
      .then((response) => {
        if (!cancelled) {
          setDeliveries(response.items)
        }
      })
      .catch(() => undefined)
    // 检测旧版 localStorage 配置，提示一键迁移到服务端加密存储
    const pending = Object.entries(LEGACY_LOCALSTORAGE_KEYS)
      .filter(([, storageKey]) => Boolean(readLegacyWebhookValue(storageKey)))
      .map(([provider]) => provider)
    setMigratable(pending)
    return () => {
      cancelled = true
    }
  }, [currentVideoUrl])

  const refreshDeliveries = useCallback(async () => {
    try {
      const response = await fetchExportDeliveries({ videoUrl: currentVideoUrl, limit: 5 })
      setDeliveries(response.items)
    } catch {
      // 历史列表刷新失败不打断主流程
    }
  }, [currentVideoUrl])

  const handleDownload = useCallback(
    async (format: string) => {
      if (busy) {
        return
      }
      setBusy(`download-${format}`)
      try {
        const response = await renderExportApi({ videoUrl: currentVideoUrl }, format)
        window.open(response.downloadUrl, '_blank')
      } catch (downloadError: unknown) {
        if (downloadError instanceof ExportApiError && downloadError.status === 401) {
          setNeedsAuth(true)
        } else {
          toast({
            variant: 'destructive',
            title: `${format.toUpperCase()} 导出失败`,
            description: downloadError instanceof Error ? downloadError.message : '请稍后重试',
          })
        }
      } finally {
        setBusy(null)
      }
    },
    [busy, currentVideoUrl, toast],
  )

  const handleSaveSecret = useCallback(
    async (provider: string) => {
      const secret = (secrets[provider] ?? '').trim()
      if (!secret || busy) {
        return
      }
      setBusy(`save-${provider}`)
      try {
        await saveExportIntegration(provider, secret)
        setSecrets((prev) => ({ ...prev, [provider]: '' }))
        const response = await fetchExportIntegrations()
        setIntegrations(response.integrations)
        toast({ description: '凭据已加密保存到服务端 ✅' })
      } catch (saveError: unknown) {
        toast({
          variant: 'destructive',
          title: '保存失败',
          description: saveError instanceof Error ? saveError.message : '请稍后重试',
        })
      } finally {
        setBusy(null)
      }
    },
    [busy, secrets, toast],
  )

  const handleRevoke = useCallback(
    async (provider: string) => {
      if (busy) {
        return
      }
      setBusy(`revoke-${provider}`)
      try {
        await revokeExportIntegration(provider)
        const response = await fetchExportIntegrations()
        setIntegrations(response.integrations)
        toast({ description: '集成已撤销' })
      } catch (revokeError: unknown) {
        toast({
          variant: 'destructive',
          title: '撤销失败',
          description: revokeError instanceof Error ? revokeError.message : '请稍后重试',
        })
      } finally {
        setBusy(null)
      }
    },
    [busy, toast],
  )

  const handleMigrate = useCallback(async () => {
    if (busy || !migratable.length) {
      return
    }
    setBusy('migrate')
    try {
      for (const provider of migratable) {
        const storageKey = LEGACY_LOCALSTORAGE_KEYS[provider]
        const value = readLegacyWebhookValue(storageKey)
        if (value) {
          await saveExportIntegration(provider, value)
          window.localStorage.removeItem(storageKey)
        }
      }
      const response = await fetchExportIntegrations()
      setIntegrations(response.integrations)
      setMigratable([])
      toast({ description: '本地配置已迁移到服务端（加密存储）✅' })
    } catch (migrateError: unknown) {
      toast({
        variant: 'destructive',
        title: '迁移失败',
        description: migrateError instanceof Error ? migrateError.message : '请稍后重试',
      })
    } finally {
      setBusy(null)
    }
  }, [busy, migratable, toast])

  const handleDeliver = useCallback(
    async (provider: string) => {
      if (busy) {
        return
      }
      setBusy(`deliver-${provider}`)
      try {
        await deliverExportApi({ videoUrl: currentVideoUrl, provider })
        toast({ description: '投递成功 ✅' })
        await refreshDeliveries()
      } catch (deliverError: unknown) {
        if (deliverError instanceof ExportApiError && deliverError.status === 401) {
          setNeedsAuth(true)
        }
        toast({
          variant: 'destructive',
          title: '投递失败',
          description: deliverError instanceof Error ? deliverError.message : '可在下方记录中重试',
        })
        await refreshDeliveries()
      } finally {
        setBusy(null)
      }
    },
    [busy, currentVideoUrl, refreshDeliveries, toast],
  )

  const handleRetry = useCallback(
    async (deliveryId: string) => {
      if (busy) {
        return
      }
      setBusy(`retry-${deliveryId}`)
      try {
        await retryExportDelivery(deliveryId)
        toast({ description: '重试成功 ✅' })
        await refreshDeliveries()
      } catch (retryError: unknown) {
        toast({
          variant: 'destructive',
          title: '重试仍失败',
          description: retryError instanceof Error ? retryError.message : '请稍后再试',
        })
        await refreshDeliveries()
      } finally {
        setBusy(null)
      }
    },
    [busy, refreshDeliveries, toast],
  )

  if (needsAuth) {
    return (
      <div className="mx-auto mt-6 max-w-3xl rounded-xl border-2 border-dashed bg-white px-4 py-3 text-sm text-slate-400 dark:bg-slate-900">
        登录后可使用导出与集成（Markdown/PDF/DOCX/JSON、Flomo、飞书、Notion）。
      </div>
    )
  }
  if (!loaded) {
    return null
  }

  return (
    <div className="mx-auto mt-6 max-w-3xl rounded-xl border-2 bg-white p-4 shadow-sm dark:bg-slate-900">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-600 dark:text-slate-300">导出</h4>
        <span className="text-xs text-slate-400">只读既有结果，不会重新生成</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {FORMATS.map((item) => (
          <button
            key={item.format}
            type="button"
            disabled={busy === `download-${item.format}`}
            onClick={() => handleDownload(item.format)}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-700 transition hover:border-pink-400 hover:text-pink-600 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200"
          >
            {busy === `download-${item.format}` ? '生成中…' : item.label}
          </button>
        ))}
      </div>

      {migratable.length > 0 && (
        <div className="mt-3 flex items-center justify-between rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700 dark:bg-amber-950">
          <span className="text-amber-700 dark:text-amber-300">
            检测到本地保存的 Webhook 配置，可迁移到服务端加密存储。
          </span>
          <button
            type="button"
            disabled={busy === 'migrate'}
            onClick={handleMigrate}
            className="ml-3 shrink-0 rounded-md bg-amber-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-50"
          >
            一键迁移
          </button>
        </div>
      )}

      <div className="mt-4 space-y-2">
        <h4 className="text-sm font-semibold text-slate-600 dark:text-slate-300">集成</h4>
        {providers.map((provider) => {
          const integration = integrationOf(integrations, provider.id)
          const configured = Boolean(integration) || provider.envConfigured
          const deliverable = provider.kind !== 'unimplemented' && configured
          return (
            <div
              key={provider.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm dark:border-slate-700"
            >
              <span className="font-medium text-slate-700 dark:text-slate-200">{provider.displayName}</span>
              {provider.kind === 'unimplemented' && (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-400 dark:bg-slate-800">
                  未实现
                </span>
              )}
              {provider.kind === 'app' && (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-400 dark:bg-slate-800">
                  {provider.envConfigured ? '凭据已配置（服务端 env）' : '需在服务端 env 配置凭据'}
                </span>
              )}
              {provider.kind === 'webhook' && (
                <span className="text-xs text-slate-400">
                  {integration ? '已加密配置' : provider.secretLabel ?? ''}
                </span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {provider.kind === 'webhook' && !integration && (
                  <input
                    type="password"
                    value={secrets[provider.id] ?? ''}
                    onChange={(event) => setSecrets((prev) => ({ ...prev, [provider.id]: event.target.value }))}
                    placeholder="粘贴 Webhook 链接"
                    className="w-56 rounded border border-slate-200 bg-transparent px-2 py-1 text-xs dark:border-slate-700"
                  />
                )}
                {provider.kind === 'webhook' && !integration && (
                  <button
                    type="button"
                    disabled={busy === `save-${provider.id}` || !(secrets[provider.id] ?? '').trim()}
                    onClick={() => handleSaveSecret(provider.id)}
                    className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:border-pink-400 hover:text-pink-600 disabled:opacity-50 dark:border-slate-700"
                  >
                    加密保存
                  </button>
                )}
                {deliverable && (
                  <button
                    type="button"
                    disabled={busy === `deliver-${provider.id}`}
                    onClick={() => handleDeliver(provider.id)}
                    className="rounded-md border border-slate-200 px-2 py-1 text-xs hover:border-pink-400 hover:text-pink-600 disabled:opacity-50 dark:border-slate-700"
                  >
                    {busy === `deliver-${provider.id}` ? '投递中…' : '立即投递'}
                  </button>
                )}
                {integration && (
                  <button
                    type="button"
                    disabled={busy === `revoke-${provider.id}`}
                    onClick={() => handleRevoke(provider.id)}
                    className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-400 hover:border-red-400 hover:text-red-500 disabled:opacity-50 dark:border-slate-700"
                  >
                    撤销
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {deliveries.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">最近投递</h4>
          <div className="space-y-1.5">
            {deliveries.map((delivery) => (
              <div
                key={delivery.id}
                className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-1.5 text-xs dark:bg-slate-800"
              >
                <span className={delivery.status === 'succeeded' ? 'text-emerald-600' : 'text-red-500'}>
                  {delivery.status === 'succeeded' ? '✓' : '✗'}
                </span>
                <span className="font-medium text-slate-600 dark:text-slate-300">{delivery.provider}</span>
                <span className="text-slate-400">
                  {delivery.createdAt ? new Date(delivery.createdAt).toLocaleString() : ''}
                </span>
                {delivery.lastErrorMessage && (
                  <span className="truncate text-slate-400" title={delivery.lastErrorMessage}>
                    {delivery.lastErrorMessage}
                  </span>
                )}
                {delivery.externalUrl && (
                  <a
                    href={delivery.externalUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sky-500 hover:underline"
                  >
                    打开
                  </a>
                )}
                <button
                  type="button"
                  disabled={busy === `retry-${delivery.id}`}
                  onClick={() => handleRetry(delivery.id)}
                  className="ml-auto rounded border border-slate-200 px-1.5 py-0.5 text-slate-500 hover:border-pink-400 hover:text-pink-600 disabled:opacity-50 dark:border-slate-700"
                >
                  重试
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
