/**
 * Вложения нити чата: документ библиотеки, веб-ссылка, отчёт или анализ ЭЭГ.
 *
 * Пока вложение прикреплено, его содержимое попадает в промпт ролей — поэтому
 * рядом стоит явное предупреждение, что материалы уходят провайдеру. Снятие —
 * одним кликом.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiErrorText } from '@/shared/api/client'
import { api } from '@/shared/api/client'
import { knowledgeApi } from '@/shared/api/knowledge'
import type { AgentAttachmentCreate } from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { SelectField } from '@/shared/ui/SelectField'
import { TextField } from '@/shared/ui/TextField'

type Kind = AgentAttachmentCreate['kind']

const KIND_LABEL: Record<Kind, string> = {
  document: 'Документ библиотеки',
  web: 'Веб-ссылка',
  report: 'Отчёт ЭЭГ',
  analysis: 'Анализ ЭЭГ',
}

export function AgentAttachments({ threadId }: { threadId: string }) {
  const queryClient = useQueryClient()
  const [kind, setKind] = useState<Kind>('document')
  const [refId, setRefId] = useState('')
  const [label, setLabel] = useState('')

  const key = ['knowledge', 'attachments', threadId]
  const attachments = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => knowledgeApi.attachments(threadId, signal),
    enabled: !!threadId,
  })
  const documents = useQuery({
    queryKey: ['knowledge', 'documents', null],
    queryFn: ({ signal }) => knowledgeApi.documents(null, signal),
    enabled: kind === 'document',
  })
  const recordings = useQuery({
    queryKey: ['recordings', 'attachments'],
    queryFn: ({ signal }) => api.recordings({ limit: 50 }, signal),
    enabled: kind === 'report',
  })
  const analyses = useQuery({
    queryKey: ['analyses', 'attachments'],
    queryFn: ({ signal }) => api.analyses({ limit: 50 }, signal),
    enabled: kind === 'analysis',
  })

  const attach = useMutation({
    mutationFn: (payload: AgentAttachmentCreate) => knowledgeApi.attach(threadId, payload),
    onSuccess: async () => {
      setRefId('')
      setLabel('')
      await queryClient.invalidateQueries({ queryKey: key })
    },
  })
  const detach = useMutation({
    mutationFn: (id: string) => knowledgeApi.detach(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  })

  const options = (() => {
    if (kind === 'document') {
      return (documents.data?.items ?? []).map((item) => ({
        value: item.id,
        label: item.title,
      }))
    }
    if (kind === 'report') {
      return (recordings.data?.items ?? []).map((item) => ({
        value: item.recording_id,
        label: `${item.patient_alias || item.filename} · ${item.n_report_runs} отчётов`,
      }))
    }
    if (kind === 'analysis') {
      return (analyses.data?.items ?? []).map((item) => ({
        value: String(item.id),
        label: `${item.patient_alias || item.filename} · ${item.kind} · ${item.n_points} точек`,
      }))
    }
    return []
  })()

  const error = attachments.error ?? attach.error ?? detach.error

  function submit() {
    if (kind === 'web') {
      const url = refId.trim()
      if (!url.startsWith('http')) return
      attach.mutate({ kind: 'web', ref_id: url, label: label.trim() || url })
      return
    }
    const chosen = options.find((option) => option.value === refId)
    if (!chosen) return
    attach.mutate({ kind, ref_id: chosen.value, label: label.trim() || chosen.label })
  }

  return (
    <details className="rounded-lg border border-border bg-bg-1 p-2">
      <summary className="cursor-pointer text-fg-0">
        Вложения нити ({attachments.data?.items.length ?? 0})
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-sm text-fg-2">
          Прикреплённые материалы попадают в промпт ролей и уходят провайдеру при
          отправке сообщения. Не прикрепляйте персональные данные без необходимости.
        </p>
        {error != null && <ErrorBlock message={apiErrorText(error)} />}
        {attachments.isPending && <LoadingBlock label="Загрузка вложений..." />}
        <ul className="flex flex-wrap gap-2">
          {(attachments.data?.items ?? []).map((item) => (
            <li
              key={item.id}
              className="flex items-center gap-1 rounded-full border border-border bg-bg-2 px-2 py-1 text-xs text-fg-1"
            >
              <span>
                {KIND_LABEL[item.kind]}: {item.label}
              </span>
              <button
                type="button"
                aria-label={`Снять вложение ${item.label}`}
                className="text-fg-2 hover:text-danger"
                onClick={() => detach.mutate(item.id)}
              >
                ×
              </button>
            </li>
          ))}
          {(attachments.data?.items ?? []).length === 0 && !attachments.isPending && (
            <li className="text-sm text-fg-2">Вложений нет.</li>
          )}
        </ul>

        <SelectField
          label="Тип вложения"
          value={kind}
          options={(Object.keys(KIND_LABEL) as Kind[]).map((value) => ({
            value,
            label: KIND_LABEL[value],
          }))}
          onChange={(next) => {
            setKind(next)
            setRefId('')
          }}
        />

        {kind === 'web' ? (
          <TextField
            label="Ссылка"
            value={refId}
            onChange={setRefId}
            placeholder="https://..."
          />
        ) : (
          <SelectField
            label="Что прикрепить"
            value={refId}
            options={[{ value: '', label: '— выберите —' }, ...options]}
            onChange={setRefId}
          />
        )}

        <TextField
          label="Подпись (необязательно)"
          value={label}
          onChange={setLabel}
          placeholder="Как называть в чате"
        />
        <Button variant="primary" disabled={!refId.trim() || attach.isPending} onClick={submit}>
          Прикрепить
        </Button>
      </div>
    </details>
  )
}
