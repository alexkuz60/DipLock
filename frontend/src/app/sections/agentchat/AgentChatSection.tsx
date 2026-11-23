/**
 * «Консилиум»: общий чат исследователя с ролевыми ИИ-агентами.
 *
 * Адресат — `@Роль` в тексте или чипы под полем ввода; все роли видят всю
 * нить. Отправка — только кнопкой («правило кнопки», `docs/rules/frontend-state.md`);
 * частичный текст идущего ответа виден из стрима, готовый дочитывается
 * поллингом из БД (стрим — только удобство).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { apiErrorText } from '@/shared/api/client'
import { agentChatApi, agentReplyStreamUrl } from '@/shared/api/agentChat'
import { knowledgeApi } from '@/shared/api/knowledge'
import type { AgentMessage, AgentRole } from '@/shared/api/types'
import {
  applyStreamEvent,
  emptyLiveRound,
  subscribeStream,
  type LiveRound,
} from '@/shared/lib/streamEvents'
import { Button } from '@/shared/ui/Button'
import { cx } from '@/shared/ui/cx'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { WarnList } from '@/shared/ui/WarnList'
import { AgentWebSearch } from './AgentWebSearch'
import { AgentAttachments } from './AgentAttachments'

function mentionText(label: string): string {
  return `@${label} `
}

export function AgentChatSection() {
  const [params, setParams] = useSearchParams()
  const threadId = params.get('thread') ?? ''
  const queryClient = useQueryClient()
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [live, setLive] = useState<Record<string, LiveRound>>({})

  const roles = useQuery({
    queryKey: ['agent-chat', 'roles'],
    queryFn: ({ signal }) => agentChatApi.roles(signal),
  })
  const threads = useQuery({
    queryKey: ['agent-chat', 'threads'],
    queryFn: ({ signal }) => agentChatApi.threads(signal),
  })
  const messages = useQuery({
    queryKey: ['agent-chat', 'messages', threadId],
    queryFn: ({ signal }) => agentChatApi.messages(threadId, signal),
    enabled: !!threadId,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === 'running') ? 2000 : false,
  })

  const enabledRoles = useMemo(
    () => (roles.data?.items ?? []).filter((role) => role.enabled),
    [roles.data],
  )
  const labelOf = useMemo(() => {
    const map: Record<string, string> = {}
    for (const role of roles.data?.items ?? []) map[role.id] = role.label
    return map
  }, [roles.data])
  const items = messages.data?.items ?? []
  const runningIds = items.filter((item) => item.status === 'running').map((item) => item.id)
  const runningKey = runningIds.join(',')

  useEffect(() => {
    if (!threadId || runningIds.length === 0) return
    const stops = runningIds.map((id) => {
      const role = items.find((item) => item.id === id)?.role_id ?? ''
      return subscribeStream(agentReplyStreamUrl(threadId, id), (event) => {
        setLive((previous) => {
          const next = applyStreamEvent(
            previous[id] ?? emptyLiveRound(id), id, { ...event, role: event.role ?? role },
          )
          return next ? { ...previous, [id]: next } : previous
        })
      })
    })
    return () => stops.forEach((stop) => stop())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, runningKey])

  function selectThread(id: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous)
      if (id) next.set('thread', id)
      else next.delete('thread')
      return next
    })
  }

  const createThread = useMutation({
    mutationFn: (title: string) => agentChatApi.createThread(title),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['agent-chat', 'threads'] })
      selectThread(created.id)
    },
  })

  const attachId = params.get('attach') ?? ''
  const askText = params.get('ask') ?? ''
  const autoThread = useRef(false)

  useEffect(() => {
    if (!attachId && !askText) return
    if (askText) setText(askText)
    if (attachId && !threadId) {
      if (!autoThread.current) {
        autoThread.current = true
        createThread.mutate(`Wiki: ${askText.slice(0, 60) || 'вопрос Ассистенту'}`)
      }
      return
    }
    if (attachId) {
      void knowledgeApi
        .attach(threadId, { kind: 'document', ref_id: attachId, label: 'Документ из Wiki' })
        .then(() =>
          queryClient.invalidateQueries({ queryKey: ['knowledge', 'attachments', threadId] }),
        )
        .catch(() => undefined)
    }
    setParams((previous) => {
      const next = new URLSearchParams(previous)
      next.delete('attach')
      next.delete('ask')
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachId, askText, threadId])
  const deleteThread = useMutation({
    mutationFn: (id: string) => agentChatApi.deleteThread(id),
    onSuccess: async () => {
      selectThread('')
      await queryClient.invalidateQueries({ queryKey: ['agent-chat', 'threads'] })
    },
  })
  const send = useMutation({
    mutationFn: (payload: { text: string; role_ids: string[] }) =>
      agentChatApi.send(threadId, payload),
    onSuccess: async () => {
      setText('')
      await queryClient.invalidateQueries({ queryKey: ['agent-chat', 'messages', threadId] })
      await queryClient.invalidateQueries({ queryKey: ['agent-chat', 'threads'] })
    },
  })
  const retry = useMutation({
    mutationFn: (messageId: string) => agentChatApi.retry(threadId, messageId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['agent-chat', 'messages', threadId] }),
  })

  const busy = send.isPending || retry.isPending
  const canSend = !!threadId && !busy && !!text.trim()

  function togglePick(role: AgentRole) {
    setPicked((previous) =>
      previous.includes(role.id)
        ? previous.filter((id) => id !== role.id)
        : [...previous, role.id],
    )
  }

  function submit() {
    if (!canSend) return
    send.mutate({ text: text.trim(), role_ids: picked })
  }

  if (roles.isPending || threads.isPending) return <LoadingBlock label="Загрузка чата..." />
  const loadError = roles.error ?? threads.error
  if (loadError) return <ErrorBlock message={apiErrorText(loadError)} />

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Нить обсуждения"
          className="rounded-lg border border-border bg-bg-2 px-3 py-2 text-base text-fg-0"
          value={threadId}
          onChange={(event) => selectThread(event.target.value)}
        >
          <option value="">Выберите обсуждение...</option>
          {(threads.data?.items ?? []).map((item) => (
            <option key={item.id} value={item.id}>
              {item.title} ({item.messages})
            </option>
          ))}
        </select>
        <Button
          disabled={createThread.isPending}
          onClick={() =>
            createThread.mutate(`Обсуждение ${new Date().toLocaleString('ru')}`)
          }
        >
          Новое обсуждение
        </Button>
        {threadId && (
          <Button
            variant="ghost"
            disabled={deleteThread.isPending || items.some((item) => item.status === 'running')}
            onClick={() => {
              if (window.confirm('Удалить обсуждение вместе с перепиской?')) {
                deleteThread.mutate(threadId)
              }
            }}
          >
            Удалить
          </Button>
        )}
      </header>

      {!threadId && (
        <p className="text-sm text-fg-2">
          Создайте обсуждение и обращайтесь к экспертам через «@Роль» или выбором роли
          под полем ввода. Модели и инструкции ролей — в правой панели.
        </p>
      )}
      {threadId && <AgentWebSearch threadId={threadId} />}
      {threadId && <AgentAttachments threadId={threadId} />}
      {messages.error != null && <ErrorBlock message={apiErrorText(messages.error)} />}

      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto" aria-label="Переписка">
        {items.map((message: AgentMessage) => {
          const mine = message.author === 'researcher'
          const failed = message.status === 'failed' || message.status === 'interrupted'
          const stream =
            message.status === 'running' ? Object.values(live[message.id]?.roles ?? {})[0]?.text : ''
          return (
            <li
              key={message.id}
              className={cx(
                'space-y-1 rounded-lg border border-border p-3',
                mine ? 'bg-bg-2' : 'bg-bg-1',
              )}
            >
              <header className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-fg-0">
                  {mine ? 'Исследователь' : (labelOf[message.role_id ?? ''] ?? message.role_id)}
                </span>
                <span className="text-fg-2">
                  {new Date(message.created_at).toLocaleTimeString('ru')}
                </span>
                {message.model && <span className="text-fg-2">{message.model}</span>}
              </header>
              {message.text && <p className="whitespace-pre-wrap text-fg-1">{message.text}</p>}
              {message.status === 'running' && (
                <div className="space-y-1" data-testid="agent-live">
                  <p role="status" className="text-sm text-fg-2">
                    Эксперт отвечает...
                  </p>
                  {stream ? <p className="whitespace-pre-wrap text-fg-1">{stream}</p> : null}
                </div>
              )}
              {failed && (
                <div className="space-y-1">
                  <p className="text-sm text-danger">
                    Модель не ответила: {message.error ?? 'неизвестная ошибка'}
                  </p>
                  <Button disabled={busy} onClick={() => retry.mutate(message.id)}>
                    Повторить ответ
                  </Button>
                </div>
              )}
              <WarnList items={message.warnings ?? []} />
            </li>
          )
        })}
      </ul>

      {send.error != null && <ErrorBlock message={apiErrorText(send.error)} />}
      {retry.error != null && <ErrorBlock message={apiErrorText(retry.error)} />}

      <div className="space-y-2">
        <p className="rounded-lg border border-warning/40 bg-warning/10 p-2 text-sm text-fg-1">
          Сообщения передаются провайдерам, назначенным ролям в модельном роутере; это может
          быть внешний сервис. Не отправляйте персональные данные добровольцев или секреты.
          ЭЭГ и досье в чат автоматически не передаются.
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Адресаты">
          {enabledRoles.map((role) => (
            <button
              key={role.id}
              type="button"
              aria-pressed={picked.includes(role.id)}
              className={cx(
                'rounded-full border px-3 py-1 text-sm',
                picked.includes(role.id)
                  ? 'border-accent bg-accent text-bg-0'
                  : 'border-border bg-bg-2 text-fg-1 hover:bg-bg-3',
              )}
              onClick={() => togglePick(role)}
              onDoubleClick={() => setText((value) => value + mentionText(role.label))}
              title="Клик — выбрать адресата; двойной клик — вставить @упоминание в текст"
            >
              {role.label}
            </button>
          ))}
        </div>
        <textarea
          aria-label="Сообщение"
          className="min-h-24 w-full rounded-lg border border-border bg-bg-2 p-3 text-base text-fg-0"
          placeholder="Вопрос экспертам... (адресат: «@Нейрофизиолог» в тексте или чипы выше)"
          value={text}
          disabled={!threadId}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit()
          }}
        />
        <div className="flex items-center gap-3">
          <Button variant="primary" disabled={!canSend} onClick={submit}>
            Отправить
          </Button>
          <span className="text-sm text-fg-2">Ctrl+Enter — отправить</span>
        </div>
      </div>
    </div>
  )
}
