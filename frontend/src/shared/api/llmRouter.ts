/** Адреса модельного роутера ИИ; ошибки и транспорт — общие с остальным приложением. */
import { API_PREFIX, request } from './client'
import type {
  LlmChatProbeRequest,
  LlmChatProbeResult,
  LlmDecideProbeRequest,
  LlmDecideProbeResult,
  LlmProbeRequest,
  LlmProbeResult,
  LlmRouter,
  LlmRouterUpdate,
} from './types'

const base = `${API_PREFIX}/llm-router`
const json = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const llmRouterApi = {
  /** Состояние роутера: провайдеры (без ключей) и назначение маршрутов. */
  get: (signal?: AbortSignal) => request<LlmRouter>(base, { signal }),
  /** Полная замена провайдеров и маршрутов; сохранение только кнопкой. */
  update: (payload: LlmRouterUpdate) => request<LlmRouter>(base, json('PUT', payload)),
  /** Нейтральная проверка связи (без материалов дела). */
  probe: (payload: LlmProbeRequest) =>
    request<LlmProbeResult>(`${base}/probe`, json('POST', payload)),
  /** Проба советника (§10): синтетический сценарий на выбранном провайдере. */
  chatProbe: (payload: LlmChatProbeRequest) =>
    request<LlmChatProbeResult>(`${base}/chat-probe`, json('POST', payload)),
  /** Проба решающего классификатора Jev: синтетический state, без материалов дела. */
  decideProbe: (payload: LlmDecideProbeRequest) =>
    request<LlmDecideProbeResult>(`${base}/decide-probe`, json('POST', payload)),
}