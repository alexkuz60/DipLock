/** Ручной контекст и история: исправления создают ревизии, ИИ не имитируется. */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiErrorText } from '@/shared/api/client'
import { consiliumApi } from '@/shared/api/consilium'
import type {
  ConsiliumCase,
  ConsiliumContext,
  ConsiliumContextCreate,
  ConsiliumContextUpdate,
  ConsiliumMessage,
  ConsiliumMessageCreate,
  ConsiliumMessageUpdate,
} from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { SelectField } from '@/shared/ui/SelectField'
import { TextField } from '@/shared/ui/TextField'
import { ErrorBlock } from '@/shared/ui/StateViews'
import { PageButtons, QueryState, TextArea } from './common'
import { contextKinds } from './options'
import { useCaseAction } from './useCaseAction'

type ContextWrite =
  | { operation: 'create'; payload: ConsiliumContextCreate }
  | { operation: 'update'; entryId: string; payload: ConsiliumContextUpdate }

type MessageWrite =
  | { operation: 'create'; payload: ConsiliumMessageCreate }
  | { operation: 'update'; entryId: string; payload: ConsiliumMessageUpdate }

export function CaseHistory({ current }: { current: ConsiliumCase }) {
  const [offset, setOffset] = useState(0)
  const [messageOffset, setMessageOffset] = useState(0)
  const [text, setText] = useState('')
  const [kind, setKind] = useState<ConsiliumContext['kind']>('observation')
  const [author, setAuthor] = useState('Исследователь')
  const [verified, setVerified] = useState(false)
  const [advisers, setAdvisers] = useState(false)
  const [editing, setEditing] = useState<ConsiliumContext | null>(null)
  const [message, setMessage] = useState('')
  const [messageEditing, setMessageEditing] = useState<ConsiliumMessage | null>(null)
  const readOnly = current.status !== 'open'
  const contexts = useQuery({
    queryKey: ['consilium', current.id, 'context', offset],
    queryFn: ({ signal }) => consiliumApi.context(current.id, offset, signal),
    gcTime: 0,
  })
  const messages = useQuery({
    queryKey: ['consilium', current.id, 'messages', messageOffset],
    queryFn: ({ signal }) => consiliumApi.messages(current.id, messageOffset, signal),
    gcTime: 0,
  })
  const save = useCaseAction(current.id, (write: ContextWrite) =>
    write.operation === 'update'
      ? consiliumApi.editContext(current.id, write.entryId, write.payload)
      : consiliumApi.addContext(current.id, write.payload),
  )
  const saveMessage = useCaseAction(current.id, (write: MessageWrite) =>
    write.operation === 'update'
      ? consiliumApi.editMessage(current.id, write.entryId, write.payload)
      : consiliumApi.addMessage(current.id, write.payload),
  )

  function contextWrite(): ContextWrite {
    const payload: ConsiliumContextCreate = {
      request_id: crypto.randomUUID(),
      expected_version: current.version,
      text,
      kind,
      author,
      verified,
      permissions: { use_with_advisers: advisers, external_transfer: false },
      subject_code: editing?.subject_code,
      recording_id: editing?.recording_id,
      start_sec: editing?.start_sec,
      end_sec: editing?.end_sec,
      time_basis: editing?.time_basis ?? 'unspecified',
    }
    return editing
      ? {
          operation: 'update',
          entryId: editing.id,
          payload: { ...payload, expected_revision: editing.revision },
        }
      : { operation: 'create', payload }
  }

  function messageWrite(): MessageWrite {
    const payload: ConsiliumMessageCreate = {
      request_id: crypto.randomUUID(),
      expected_version: current.version,
      text: message,
    }
    return messageEditing
      ? {
          operation: 'update',
          entryId: messageEditing.id,
          payload: { ...payload, expected_revision: messageEditing.revision },
        }
      : { operation: 'create', payload }
  }

  function edit(item: ConsiliumContext) {
    setEditing(item)
    setText(item.text)
    setKind(item.kind)
    setAuthor(item.author)
    setVerified(item.verified ?? false)
    setAdvisers(item.permissions?.use_with_advisers ?? false)
    save.reset()
  }

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">Контекст добровольца и наблюдения</h3>
      <p className="text-sm text-fg-2">
        Рассказ не становится измерением ЭЭГ. Проверка означает сверку записи, а не истинность
        самоотчёта.
      </p>
      <SelectField
        label="Источник контекста"
        options={[...contextKinds]}
        value={kind}
        onChange={setKind}
        disabled={readOnly || save.isPending}
      />
      <TextField
        label="Автор / код добровольца"
        value={author}
        onChange={setAuthor}
        disabled={readOnly || save.isPending}
      />
      <TextArea
        label={editing ? 'Исправленный контекст' : 'Текст контекста'}
        value={text}
        onChange={setText}
        disabled={readOnly || save.isPending}
      />
      <CheckboxRow
        label="Запись проверена исследователем"
        checked={verified}
        onChange={setVerified}
        disabled={readOnly || save.isPending}
      />
      <CheckboxRow
        label="Разрешить использование советниками в будущем"
        checked={advisers}
        onChange={setAdvisers}
        disabled={readOnly || save.isPending}
        hint="Внешняя передача по умолчанию запрещена; сейчас ИИ не запускается."
      />
      <Button
        variant="primary"
        disabled={readOnly || save.isPending || !text.trim() || !author.trim()}
        onClick={() =>
          save.mutate(contextWrite(), {
            onSuccess: () => {
              setText('')
              setEditing(null)
            },
          })
        }
      >
        {editing ? 'Сохранить новую ревизию контекста' : 'Добавить контекст'}
      </Button>
      {editing && (
        <Button
          onClick={() => {
            setEditing(null)
            setText('')
          }}
        >
          Отменить исправление
        </Button>
      )}
      {save.error && (
        <ErrorBlock
          message={apiErrorText(save.error)}
          onRetry={() => {
            if (save.variables) save.mutate(save.variables)
          }}
        />
      )}
      <QueryState
        loading={contexts.isPending}
        error={contexts.error}
        retry={() => {
          void contexts.refetch()
        }}
      />
      {contexts.data?.items.map((item) => (
        <article
          key={`${item.id}:${item.revision}`}
          className="space-y-1 rounded-lg border border-border p-3"
        >
          <p className="text-sm text-fg-2">
            {contextKinds.find((option) => option.value === item.kind)?.label} · {item.author} ·
            ревизия {item.revision}
            {item.verified ? ' · проверено' : ' · не проверено'}
          </p>
          <p className="whitespace-pre-wrap">{item.text}</p>
          <Button variant="ghost" disabled={readOnly} onClick={() => edit(item)}>
            Исправить контекст
          </Button>
        </article>
      ))}
      <PageButtons offset={offset} total={contexts.data?.total ?? 0} onChange={setOffset} />
      <h3 className="font-semibold">Ручная история обсуждения</h3>
      <TextArea
        label={messageEditing ? 'Исправленная реплика' : 'Реплика исследователя'}
        value={message}
        onChange={setMessage}
        disabled={readOnly || saveMessage.isPending}
      />
      <Button
        variant="primary"
        disabled={readOnly || saveMessage.isPending || !message.trim()}
        onClick={() =>
          saveMessage.mutate(messageWrite(), {
            onSuccess: () => {
              setMessage('')
              setMessageEditing(null)
            },
          })
        }
      >
        {messageEditing ? 'Сохранить новую ревизию реплики' : 'Добавить реплику'}
      </Button>
      {messageEditing && (
        <Button
          onClick={() => {
            setMessageEditing(null)
            setMessage('')
          }}
        >
          Отменить правку реплики
        </Button>
      )}
      {saveMessage.error && (
        <ErrorBlock
          message={apiErrorText(saveMessage.error)}
          onRetry={() => {
            if (saveMessage.variables) saveMessage.mutate(saveMessage.variables)
          }}
        />
      )}
      <QueryState
        loading={messages.isPending}
        error={messages.error}
        retry={() => {
          void messages.refetch()
        }}
      />
      {messages.data?.items.map((item) => (
        <article
          key={`${item.id}:${item.revision}`}
          className="rounded-lg border border-border p-3"
        >
          <p className="text-sm text-fg-2">Исследователь · ревизия {item.revision}</p>
          <p className="whitespace-pre-wrap">{item.text}</p>
          <Button
            variant="ghost"
            disabled={readOnly}
            onClick={() => {
              setMessageEditing(item)
              setMessage(item.text)
              saveMessage.reset()
            }}
          >
            Исправить реплику
          </Button>
        </article>
      ))}
      <PageButtons
        offset={messageOffset}
        total={messages.data?.total ?? 0}
        onChange={setMessageOffset}
      />
    </div>
  )
}
