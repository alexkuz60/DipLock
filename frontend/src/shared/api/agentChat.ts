/** Адреса общего чата консилиума с ролевыми ИИ-агентами. */
import { API_PREFIX, request } from './client'
import type {
  AgentMessage,
  AgentMessageCreate,
  AgentMessagesPage,
  AgentRole,
  AgentRoleCreate,
  AgentRolesPage,
  AgentRoleUpdate,
  AgentSend,
  AgentThread,
  AgentThreadsPage,
  AgentWebSearch,
  AgentWebSearchCreate,
  AgentWebSearchesPage,
} from './types'

const base = `${API_PREFIX}/agent-chat`
const thread = (id: string) => `${base}/threads/${encodeURIComponent(id)}`
const json = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

/** Адрес потока ответа агента (SSE, общий механизм стриминга). */
export function agentReplyStreamUrl(threadId: string, messageId: string): string {
  return `${thread(threadId)}/messages/${encodeURIComponent(messageId)}/stream`
}

export const agentChatApi = {
  roles: (signal?: AbortSignal) => request<AgentRolesPage>(`${base}/roles`, { signal }),
  createRole: (payload: AgentRoleCreate) =>
    request<AgentRole>(`${base}/roles`, json('POST', payload)),
  updateRole: (id: string, payload: AgentRoleUpdate) =>
    request<AgentRole>(`${base}/roles/${encodeURIComponent(id)}`, json('PUT', payload)),
  deleteRole: (id: string) =>
    request<void>(`${base}/roles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  threads: (signal?: AbortSignal) => request<AgentThreadsPage>(`${base}/threads`, { signal }),
  createThread: (title: string) =>
    request<AgentThread>(`${base}/threads`, json('POST', { title })),
  deleteThread: (id: string) => request<void>(thread(id), { method: 'DELETE' }),
  messages: (id: string, signal?: AbortSignal) =>
    request<AgentMessagesPage>(`${thread(id)}/messages`, { signal }),
  /** Сообщение исследователя; ответы адресатов — задачи очереди (202). */
  send: (id: string, payload: AgentMessageCreate) =>
    request<AgentSend>(`${thread(id)}/messages`, json('POST', payload)),
  retry: (id: string, messageId: string) =>
    request<AgentMessage>(
      `${thread(id)}/messages/${encodeURIComponent(messageId)}/retry`,
      { method: 'POST' },
    ),
  /** Поиски нити, новые сверху. */
  webSearches: (id: string, signal?: AbortSignal) =>
    request<AgentWebSearchesPage>(`${thread(id)}/web-search`, { signal }),
  /** Веб-поиск: запрос уходит поисковику только по этой кнопке. */
  webSearch: (id: string, payload: AgentWebSearchCreate) =>
    request<AgentWebSearch>(`${thread(id)}/web-search`, json('POST', payload)),
  /** Перевод найденных материалов на русский — отдельным явным действием. */
  translateWebSearch: (id: string, searchId: string) =>
    request<AgentWebSearch>(
      `${thread(id)}/web-search/${encodeURIComponent(searchId)}/translate`,
      { method: 'POST' },
    ),
}
