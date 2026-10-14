/**
 * Живой стрим событий раунда (срез 0011): подписка на SSE и наложение дельт.
 *
 * Стрим — только удобство: готовые ответы приходят поллингом из БД, поэтому
 * обрыв потока не ошибка (`onError` молча переводит клиента к поллингу), а
 * поздние события другого запуска отбрасываются по `roundId` — состояние
 * чужого раунда не подменяется (`docs/rules/frontend-state.md`).
 */
import { API_PREFIX } from '@/shared/api/client'
import type { ConsiliumStreamEvent } from '@/shared/api/types'

export type LiveRole = {
  status: 'waiting' | 'streaming' | 'done' | 'failed'
  text: string
  model: string | null
  error: string | null
}

export type LiveRound = {
  roundId: string
  roles: Record<string, LiveRole>
  finished: boolean
  error: string | null
}

export function emptyLiveRound(roundId: string): LiveRound {
  return { roundId, roles: {}, finished: false, error: null }
}

const EMPTY_ROLE: LiveRole = { status: 'waiting', text: '', model: null, error: null }

/** Наложить событие потока: дельты складываются по роли, границы меняют статус. */
export function applyStreamEvent(
  live: LiveRound | null,
  roundId: string,
  event: ConsiliumStreamEvent,
): LiveRound | null {
  // Поздние события другого запуска состояние не трогают
  if (live != null && live.roundId !== roundId) return live
  const current = live ?? emptyLiveRound(roundId)
  if (event.type === 'ping') return current
  if (event.type === 'round_done') {
    return { ...current, finished: true, error: event.error ?? null }
  }
  if (event.type === 'error') {
    return { ...current, error: event.error ?? null }
  }
  const role = event.role
  if (!role) return current
  const entry = current.roles[role] ?? EMPTY_ROLE
  if (event.type === 'delta') {
    return {
      ...current,
      roles: {
        ...current.roles,
        [role]: { ...entry, status: 'streaming', text: entry.text + (event.delta ?? '') },
      },
    }
  }
  if (event.type === 'role_started') {
    return { ...current, roles: { ...current.roles, [role]: { ...entry, status: 'streaming' } } }
  }
  // role_done: итоговый статус роли, модель и честная ошибка
  const status = event.status === 'done' || event.status === 'failed' ? event.status : entry.status
  return {
    ...current,
    roles: {
      ...current.roles,
      [role]: {
        ...entry,
        status,
        model: event.model ?? entry.model,
        error: event.error ?? entry.error,
      },
    },
  }
}

/** Адрес потока событий раунда (SSE). */
export function roundStreamUrl(caseId: string, roundId: string): string {
  return (
    `${API_PREFIX}/consilium/cases/${encodeURIComponent(caseId)}` +
    `/rounds/${encodeURIComponent(roundId)}/stream`
  )
}

/** Адрес потока событий штурма (SSE, тот же механизм 0011, роль `brainstorm`). */
export function brainstormStreamUrl(caseId: string, brainstormId: string): string {
  return (
    `${API_PREFIX}/consilium/cases/${encodeURIComponent(caseId)}` +
    `/brainstorms/${encodeURIComponent(brainstormId)}/stream`
  )
}

/** Адрес потока ответа боковой консультации (SSE, механизм 0011, срез 0015). */
export function chatReplyStreamUrl(caseId: string, messageId: string): string {
  return (
    `${API_PREFIX}/consilium/cases/${encodeURIComponent(caseId)}` +
    `/chat-messages/${encodeURIComponent(messageId)}/stream`
  )
}

/** Разобрать SSE-фрейм (`data:` + JSON) в событие; мусорные фреймы — мимо. */
function parseFrame(frame: string): ConsiliumStreamEvent | null {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('')
  if (!data) return null
  try {
    return JSON.parse(data) as ConsiliumStreamEvent
  } catch {
    return null
  }
}

/**
 * Подписка на стрим (раунд или штурм — механизм 0011): события приходят в
 * `onEvent`, обрыв/отказ — в `onError` (клиент остаётся на поллинге).
 * Возврат — отмена подписки.
 */
export function subscribeStream(
  url: string,
  onEvent: (event: ConsiliumStreamEvent) => void,
  onError?: () => void,
): () => void {
  const controller = new AbortController()
  void (async () => {
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      })
      if (!response.ok || !response.body) {
        onError?.()
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let sep = buffer.indexOf('\n\n')
        while (sep >= 0) {
          const parsed = parseFrame(buffer.slice(0, sep))
          if (parsed) onEvent(parsed)
          buffer = buffer.slice(sep + 2)
          sep = buffer.indexOf('\n\n')
        }
      }
    } catch {
      if (!controller.signal.aborted) onError?.()
    }
  })()
  return () => controller.abort()
}

/** Подписка на стрим раунда: обёртка над общим `subscribeStream`. */
export function subscribeRoundStream(
  caseId: string,
  roundId: string,
  onEvent: (event: ConsiliumStreamEvent) => void,
  onError?: () => void,
): () => void {
  return subscribeStream(roundStreamUrl(caseId, roundId), onEvent, onError)
}

/** Подписка на стрим штурма (роль `brainstorm`): тот же механизм 0011. */
export function subscribeBrainstormStream(
  caseId: string,
  brainstormId: string,
  onEvent: (event: ConsiliumStreamEvent) => void,
  onError?: () => void,
): () => void {
  return subscribeStream(brainstormStreamUrl(caseId, brainstormId), onEvent, onError)
}