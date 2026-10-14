/**
 * Боковая консультация (срез 0015): чат исследователя с одним советником.
 *
 * Отправка — только кнопкой (правило «UI не запускает обработку»); ответ
 * советника идёт задачей очереди: частичный текст виден из стрима (механизм
 * 0011), готовый дочитывается поллингом из БД. Переписка — append-only:
 * неудавшийся ответ повторяется новой попыткой, реплики не правятся.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiErrorText } from '@/shared/api/client'
import { consiliumApi } from '@/shared/api/consilium'
import type { ConsiliumCase, ConsiliumChatMessageCreate } from '@/shared/api/types'
import {
  applyStreamEvent,
  chatReplyStreamUrl,
  emptyLiveRound,
  subscribeStream,
  type LiveRound,
} from '@/shared/lib/roundStream'
import { useConsiliumOptions } from '@/shared/state/consiliumOptions'
import { Button } from '@/shared/ui/Button'
import { SelectField } from '@/shared/ui/SelectField'
import { TextField } from '@/shared/ui/TextField'
import { ErrorBlock } from '@/shared/ui/StateViews'
import { WarnList } from '@/shared/ui/WarnList'
import { QueryState } from './common'
import { advisorRoles, advisorRoleLabel } from './options'
import { useCaseAction } from './useCaseAction'

/** Советники чата: три роли, «Итог консилиума» — отдельное действие раундов. */
const CHAT_ROLES = advisorRoles
  .filter((item) => item.value !== 'summary')
  .map((item) => ({ value: item.value, label: item.label }))

export function ConsultationChat({ current }: { current: ConsiliumCase }) {
  const role = useConsiliumOptions((state) => state.sidebar.chatRole)
  const setChatRole = useConsiliumOptions((state) => state.setChatRole)
  const [text, setText] = useState('')
  const [live, setLive] = useState<LiveRound | null>(null)
  const readOnly = current.status !== 'open'

  const snapshots = useQuery({
    queryKey: ['consilium', current.id, 'snapshots'],
    queryFn: ({ signal }) => consiliumApi.snapshots(current.id, 0, signal),
    gcTime: 0,
  })
  // Нити чата: одна на пару (дело, советник), заводится при первом сообщении
  const chats = useQuery({
    queryKey: ['consilium', current.id, 'chats'],
    queryFn: ({ signal }) => consiliumApi.chats(current.id, signal),
    gcTime: 0,
  })
  const chat = chats.data?.items.find((item) => item.role === role)
  const messages = useQuery({
    queryKey: ['consilium', current.id, 'chats', chat?.id ?? '', 'messages'],
    queryFn: ({ signal }) => consiliumApi.chatMessages(current.id, chat!.id, signal),
    gcTime: 0,
    enabled: !!chat,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.status === 'running') ? 2000 : false,
  })
  const latestSnapshot = snapshots.data?.items[0]
  const items = messages.data?.items ?? []
  const runningId =
    items.find((item) => item.author === 'advisor' && item.status === 'running')?.id ?? ''

  // Живой стрим (механизм 0011): растущий текст идущего ответа виден сразу;
  // готовый ответ всё равно приходит поллингом из БД (стрим — только удобство)
  useEffect(() => {
    if (!runningId) return
    setLive(emptyLiveRound(runningId))
    return subscribeStream(chatReplyStreamUrl(current.id, runningId), (event) => {
      setLive((previous) => applyStreamEvent(previous, runningId, event))
    })
  }, [current.id, runningId])

  const send = useCaseAction<ConsiliumChatMessageCreate>(current.id, (payload) =>
    consiliumApi.sendChatMessage(current.id, payload),
  )
  const retry = useCaseAction<string>(current.id, (messageId) =>
    consiliumApi.retryChatMessage(current.id, messageId, {
      request_id: crypto.randomUUID(),
      expected_version: current.version,
    }),
  )
  const busy = send.isPending || retry.isPending || !!runningId
  const blocked = readOnly || busy || !latestSnapshot

  function submit() {
    if (blocked || !text.trim()) return
    send.mutate(
      {
        request_id: crypto.randomUUID(),
        expected_version: current.version,
        role: role as 'psychological',
        text: text.trim(),
      },
      { onSuccess: () => setText('') },
    )
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-fg-2">
        Личная консультация с одним советником: вопрос идёт по опубликованному снимку
        досье и этой переписке. Реплики не правятся, неудавшийся ответ повторяется
        новой попыткой.
      </p>
      <SelectField label="Советник" value={role} options={CHAT_ROLES} onChange={setChatRole} />
      {latestSnapshot ? (
        <p className="text-sm text-fg-2">
          Основание: снимок от {new Date(latestSnapshot.created_at).toLocaleString('ru')}
        </p>
      ) : (
        <p className="text-sm text-fg-2">
          Нет опубликованного снимка досье — опубликуйте досье на вкладке «Материалы и
          досье», иначе консультация недоступна.
        </p>
      )}
      <QueryState
        loading={chats.isPending || (!!chat && messages.isPending)}
        error={chats.error ?? messages.error}
        retryLabel="Обновить переписку"
        retry={() => {
          void chats.refetch()
          if (chat) void messages.refetch()
        }}
      />
      {!chat && chats.data && <p className="text-sm text-fg-2">Переписка пуста.</p>}
      <ul className="space-y-2">
        {items.map((message) => {
          const liveRole = message.id === runningId ? live?.roles[role] : undefined
          const failed =
            message.author === 'advisor' && message.status !== 'ok' && message.status !== 'running'
          return (
            <li
              key={message.id}
              id={`chat-${message.id}`}
              className="space-y-1 rounded-lg border border-border p-2"
            >
              <header className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-fg-0">
                  {message.author === 'researcher'
                    ? 'Исследователь'
                    : advisorRoleLabel(message.role)}
                </span>
                <span className="text-fg-2">
                  {new Date(message.created_at).toLocaleString('ru')}
                </span>
                {message.model && <span className="text-fg-2">{message.model}</span>}
              </header>
              {message.text && <p className="whitespace-pre-wrap text-fg-1">{message.text}</p>}
              {message.status === 'running' && (
                <div className="space-y-1" data-testid="chat-live">
                  <p role="status" className="text-sm text-fg-2">
                    Запрос к внешней модели выполняется…
                  </p>
                  {liveRole?.text ? (
                    <p className="whitespace-pre-wrap text-fg-1">{liveRole.text}</p>
                  ) : null}
                </div>
              )}
              {failed && (
                <div className="space-y-1">
                  <p className="text-sm text-danger">
                    Модель не ответила: {message.error ?? 'неизвестная ошибка'}
                  </p>
                  <Button disabled={blocked} onClick={() => retry.mutate(message.id)}>
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
        <TextField
          label="Сообщение советнику"
          value={text}
          onChange={setText}
          placeholder="Вопрос или уточнение…"
          disabled={blocked}
        />
        <Button variant="primary" disabled={blocked || !text.trim()} onClick={submit}>
          Отправить
        </Button>
      </div>
    </div>
  )
}