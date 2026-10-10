/**
 * Панель «Модельный роутер ИИ» раздела «Настройки»: провайдеры внешних API
 * полноценных моделей и маршруты chat/transcribe (llama.cpp отклонён 10.10.2026).
 *
 * Правила: правка формы ничего не отправляет наружу (считает только кнопка
 * «Сохранить»), ключ вводится один раз и не возвращается сервером (только маска
 * `key_hint`), «Проверить связь» шлёт нейтральный запрос без материалов дела.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { llmRouterApi } from '@/shared/api/llmRouter'
import { apiErrorText } from '@/shared/api/client'
import type { LlmProbeResult, LlmProviderIn, LlmRouterUpdate, LlmRoutes } from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { Panel } from '@/shared/ui/Panel'
import { SelectField } from '@/shared/ui/SelectField'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { TextField } from '@/shared/ui/TextField'

type Protocol = LlmProviderIn['protocol']

/** Строка формы провайдера: id=null — новый (id назначит сервер). */
type ProviderRow = {
  id: string | null
  label: string
  protocol: Protocol
  baseUrl: string
  model: string
  enabled: boolean
  /** Введённый ключ: пусто — не менять серверный; «Забыть ключ» — очистить */
  apiKey: string
  /** Серверная маска (…abcd) для подсказки поля */
  keyHint: string | null
  clearKey: boolean
}

type ProbeState = { pending: boolean; result: LlmProbeResult | null }

const PROTOCOL_OPTIONS: { value: Protocol; label: string; hint: string }[] = [
  {
    value: 'openai',
    label: 'OpenAI-совместимый',
    hint: '/chat/completions: OpenAI, DeepSeek, Groq, OpenRouter, GigaChat/YandexGPT-совместимые',
  },
  { value: 'anthropic', label: 'Anthropic Messages', hint: 'Claude: /messages (без распознавания)' },
]

function emptyRow(): ProviderRow {
  return {
    id: null,
    label: '',
    protocol: 'openai',
    baseUrl: 'https://',
    model: '',
    enabled: true,
    apiKey: '',
    keyHint: null,
    clearKey: false,
  }
}

/** Тело PUT: api_key отправляется только при явном действии (ввод/очистка). */
function toProviderIn(row: ProviderRow): LlmProviderIn {
  const base: LlmProviderIn = {
    id: row.id,
    label: row.label.trim(),
    protocol: row.protocol,
    base_url: row.baseUrl.trim(),
    model: row.model.trim(),
    enabled: row.enabled,
  }
  if (row.clearKey) return { ...base, api_key: '' }
  if (row.apiKey) return { ...base, api_key: row.apiKey }
  return base
}

export function ModelRouterPanel() {
  const queryClient = useQueryClient()
  const routerQuery = useQuery({
    queryKey: ['llmRouter'],
    queryFn: ({ signal }) => llmRouterApi.get(signal),
    staleTime: 30_000,
    retry: false,
  })

  /** Черновик формы: null — ещё не заполнен из сервера (поздний ответ не мешает правке). */
  const [rows, setRows] = useState<ProviderRow[] | null>(null)
  const [routes, setRoutes] = useState<LlmRoutes>({ chat: null, transcribe: null })
  const [dirty, setDirty] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, ProbeState>>({})

  useEffect(() => {
    const data = routerQuery.data
    if (!data || rows !== null) return
    setRows(
      data.providers.map((provider) => ({
        id: provider.id,
        label: provider.label,
        protocol: provider.protocol,
        baseUrl: provider.base_url,
        model: provider.model,
        enabled: provider.enabled,
        apiKey: '',
        keyHint: provider.key_hint ?? null,
        clearKey: false,
      })),
    )
    setRoutes({ chat: data.routes.chat, transcribe: data.routes.transcribe })
  }, [routerQuery.data, rows])

  const editRow = (index: number, patch: Partial<ProviderRow>) => {
    setRows((prev) => (prev ? prev.map((row, i) => (i === index ? { ...row, ...patch } : row)) : prev))
    setDirty(true)
  }

  const addRow = () => {
    setRows((prev) => [...(prev ?? []), emptyRow()])
    setDirty(true)
  }

  const removeRow = (index: number) => {
    setRows((prev) => {
      if (!prev) return prev
      const removed = prev[index]
      if (removed.id) {
        setRoutes((current) => ({
          chat: current.chat === removed.id ? null : current.chat,
          transcribe: current.transcribe === removed.id ? null : current.transcribe,
        }))
      }
      return prev.filter((_, i) => i !== index)
    })
    setDirty(true)
  }

  const save = useMutation({
    mutationFn: (payload: LlmRouterUpdate) => llmRouterApi.update(payload),
    onSuccess: (data) => {
      queryClient.setQueryData(['llmRouter'], data)
      setRows(
        data.providers.map((provider) => ({
          id: provider.id,
          label: provider.label,
          protocol: provider.protocol,
          baseUrl: provider.base_url,
          model: provider.model,
          enabled: provider.enabled,
          apiKey: '',
          keyHint: provider.key_hint ?? null,
          clearKey: false,
        })),
      )
      setRoutes({ chat: data.routes.chat, transcribe: data.routes.transcribe })
      setDirty(false)
      setSaveError(null)
    },
    onError: (error) => setSaveError(apiErrorText(error)),
  })

  /** Нейтральная проверка связи (без материалов дела) — только по сохранённому провайдеру. */
  const runProbe = async (providerId: string) => {
    setProbes((prev) => ({ ...prev, [providerId]: { pending: true, result: null } }))
    try {
      const result = await llmRouterApi.probe({ provider_id: providerId, route: 'chat' })
      setProbes((prev) => ({ ...prev, [providerId]: { pending: false, result } }))
    } catch (error) {
      setProbes((prev) => ({
        ...prev,
        [providerId]: {
          pending: false,
          result: {
            ok: false,
            provider_id: providerId,
            route: 'chat',
            model: null,
            latency_ms: null,
            error: apiErrorText(error),
          },
        },
      }))
    }
  }

  const panelHint =
    'Полноценные модели через внешние API (llama.cpp отклонён 10.10.2026). Ключи хранятся ' +
    'на сервере и в интерфейс не возвращаются; материалы дела уходят провайдеру только ' +
    'явным действием в разделе «Консилиум».'

  if (routerQuery.isPending) {
    return (
      <Panel title="Модельный роутер ИИ" hint={panelHint}>
        <LoadingBlock />
      </Panel>
    )
  }
  if (routerQuery.isError) {
    return (
      <Panel title="Модельный роутер ИИ" hint={panelHint}>
        <ErrorBlock message={apiErrorText(routerQuery.error)} />
      </Panel>
    )
  }

  const providerRows = rows ?? []
  const savedProviders = providerRows.filter((row) => row.id !== null)
  const routeOptions = [
    { value: '', label: '— не назначен' },
    ...savedProviders.map((row) => ({
      value: row.id as string,
      label: row.label.trim() || 'Без имени',
    })),
  ]
  const transcribeOptions = [
    { value: '', label: '— не назначен' },
    ...savedProviders.map((row) => ({
      value: row.id as string,
      label: row.label.trim() || 'Без имени',
      disabled: row.protocol !== 'openai',
    })),
  ]

  return (
    <Panel title="Модельный роутер ИИ" hint={panelHint}>
      <p className="text-sm text-fg-2">
        Маршруты указывают, каким провайдером пользуются советники (chat) и распознавание
        (transcribe). «Проверить связь» шлёт нейтральный запрос без данных дела.
      </p>

      {providerRows.length === 0 ? (
        <p className="text-sm text-fg-2">
          Провайдеры не добавлены — ИИ-советники и распознавание недоступны.
        </p>
      ) : null}

      {providerRows.map((row, index) => {
        const probeState = row.id ? probes[row.id] : undefined
        return (
          <div key={row.id ?? `new-${index}`} className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2 pb-1">
              <span className="text-sm font-medium text-fg-0">
                {row.label.trim() || 'Новый провайдер'}
              </span>
              <Button variant="ghost" onClick={() => removeRow(index)}>
                Удалить
              </Button>
            </div>
            <TextField
              label="Имя"
              value={row.label}
              onChange={(value) => editRow(index, { label: value })}
            />
            <SelectField
              label="Протокол"
              value={row.protocol}
              options={PROTOCOL_OPTIONS}
              onChange={(value) => editRow(index, { protocol: value })}
            />
            <TextField
              label="Адрес API"
              mono
              value={row.baseUrl}
              hint="Вместе с /v1: https://api.openai.com/v1, https://api.anthropic.com/v1"
              onChange={(value) => editRow(index, { baseUrl: value })}
            />
            <TextField
              label="Модель"
              mono
              value={row.model}
              onChange={(value) => editRow(index, { model: value })}
            />
            <CheckboxRow
              label="Включён"
              checked={row.enabled}
              onChange={(checked) => editRow(index, { enabled: checked })}
            />
            <div className="ui-list-row flex items-center gap-3 py-2">
              <span className="w-32 shrink-0 text-sm text-fg-2">Ключ API</span>
              <input
                type="password"
                value={row.clearKey ? '' : row.apiKey}
                disabled={row.clearKey}
                placeholder={
                  row.clearKey
                    ? 'ключ будет удалён'
                    : row.keyHint
                      ? `сохранён (${row.keyHint}); пустое поле оставит прежний`
                      : 'не задан'
                }
                onChange={(event) =>
                  editRow(index, { apiKey: event.target.value, clearKey: false })
                }
                className="w-full rounded-lg border border-border bg-bg-2 px-2.5 py-1.5 text-sm text-fg-0 disabled:cursor-not-allowed disabled:opacity-40"
              />
              {row.keyHint && !row.clearKey ? (
                <Button
                  variant="ghost"
                  onClick={() => editRow(index, { clearKey: true, apiKey: '' })}
                >
                  Забыть ключ
                </Button>
              ) : null}
              {row.clearKey ? (
                <Button variant="ghost" onClick={() => editRow(index, { clearKey: false })}>
                  Не удалять
                </Button>
              ) : null}
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Button
                disabled={!row.id || probeState?.pending || save.isPending}
                onClick={() => row.id && runProbe(row.id)}
              >
                {row.id ? 'Проверить связь' : 'Сохраните, чтобы проверить'}
              </Button>
              {probeState ? (
                <span
                  role="status"
                  className={probeState.result?.ok ? 'text-sm text-fg-1' : 'text-sm text-danger'}
                >
                  {probeState.pending
                    ? 'Проверка…'
                    : probeState.result?.ok
                      ? `Связь есть (${Math.round(probeState.result.latency_ms ?? 0)} мс)`
                      : `Нет связи: ${probeState.result?.error ?? 'неизвестная ошибка'}`}
                </span>
              ) : null}
            </div>
          </div>
        )
      })}

      <Button onClick={addRow}>Добавить провайдера</Button>

      <SelectField
        label="Советники (chat)"
        value={routes.chat ?? ''}
        options={routeOptions}
        hint="Кому поручать разговор в «Консилиуме» (Т3)"
        onChange={(value) => {
          setRoutes((prev) => ({ ...prev, chat: value || null }))
          setDirty(true)
        }}
      />
      <SelectField
        label="Распознавание (transcribe)"
        value={routes.transcribe ?? ''}
        options={transcribeOptions}
        hint="Стенограмма беседы (Т2); только OpenAI-совместимый API"
        onChange={(value) => {
          setRoutes((prev) => ({ ...prev, transcribe: value || null }))
          setDirty(true)
        }}
      />

      <div className="flex items-center gap-3 pt-2">
        <Button
          variant="primary"
          disabled={!dirty || save.isPending}
          onClick={() =>
            save.mutate({
              providers: providerRows.map(toProviderIn),
              routes: { chat: routes.chat, transcribe: routes.transcribe },
            })
          }
        >
          Сохранить
        </Button>
        {save.isPending ? <span className="text-sm text-fg-2">Сохранение…</span> : null}
      </div>
      {saveError ? (
        <p role="alert" className="text-sm text-danger">
          {saveError}
        </p>
      ) : null}
    </Panel>
  )
}