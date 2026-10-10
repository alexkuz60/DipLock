/** Выбранное дело: ключ компонента отделяет поздние ответы другого исследования. */
import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiErrorText } from '@/shared/api/client'
import { consiliumApi } from '@/shared/api/consilium'
import type {
  ConsiliumCaseCreate,
  ConsiliumCaseUpdate,
  ConsiliumDeletionPreview,
  ConsiliumRecording,
} from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { ErrorBlock } from '@/shared/ui/StateViews'
import { StatusPill } from '@/shared/ui/StatusPill'
import { CaseForm } from './CaseForm'
import { CaseHistory } from './CaseHistory'
import { CaseMaterials } from './CaseMaterials'
import { QueryState } from './common'
import { useCaseAction } from './useCaseAction'

export function CaseWorkspace({
  caseId,
  recordings,
  onDeleted,
}: {
  caseId: string
  recordings: ConsiliumRecording[]
  onDeleted: () => void
}) {
  const [tab, setTab] = useState<'history' | 'materials'>('history')
  const [editing, setEditing] = useState(false)
  const [preview, setPreview] = useState<ConsiliumDeletionPreview | null>(null)
  const queryClient = useQueryClient()
  const detail = useQuery({
    queryKey: ['consilium', caseId, 'case'],
    queryFn: ({ signal }) => consiliumApi.case(caseId, signal),
    gcTime: 0,
  })
  const update = useCaseAction(caseId, (payload: ConsiliumCaseUpdate) =>
    consiliumApi.update(caseId, payload),
  )
  const deletion = useCaseAction(caseId, (version: number) => consiliumApi.delete(caseId, version))
  const checkDeletion = useCaseAction<void>(caseId, async () => {
    setPreview(await consiliumApi.deletion(caseId))
  })
  const current = detail.data

  return (
    <section aria-label="Текущее исследование" className="space-y-4">
      <QueryState
        loading={detail.isPending}
        error={detail.error}
        retry={() => {
          void detail.refetch()
        }}
      />
      {current && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold">{current.title}</h2>
            <StatusPill tone={current.status === 'archived' ? 'warn' : 'accent'}>
              {current.status === 'archived' ? 'Архив · только чтение' : 'Открыто'} · версия{' '}
              {current.version}
            </StatusPill>
          </div>
          <p className="whitespace-pre-wrap text-fg-1">{current.question}</p>
          <p className="text-sm text-fg-2">
            Добровольцы: {current.subject_codes?.join(', ') || 'код пока не указан'} · записей:{' '}
            {current.recording_ids?.length ?? 0}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: ['consilium', caseId] })
              }}
            >
              Обновить исследование
            </Button>
            <Button
              disabled={update.isPending}
              onClick={() => {
                setEditing(!editing)
                update.reset()
              }}
            >
              Изменить паспорт
            </Button>
            <Button
              disabled={update.isPending}
              onClick={() =>
                update.mutate({
                  title: current.title,
                  question: current.question,
                  direction: current.direction,
                  subject_codes: current.subject_codes,
                  recording_ids: current.recording_ids,
                  expected_version: current.version,
                  request_id: crypto.randomUUID(),
                  status: current.status === 'open' ? 'archived' : 'open',
                })
              }
            >
              {current.status === 'open' ? 'Архивировать' : 'Открыть исследование'}
            </Button>
            <Button onClick={() => checkDeletion.mutate()} disabled={checkDeletion.isPending}>
              Посмотреть удаление
            </Button>
          </div>
          {(update.error || deletion.error || checkDeletion.error) && (
            <ErrorBlock
              message={apiErrorText(update.error ?? deletion.error ?? checkDeletion.error)}
              onRetry={() => {
                void detail.refetch()
                update.reset()
                deletion.reset()
                checkDeletion.reset()
              }}
              retryLabel="Обновить данные"
            />
          )}
          {editing && (
            <CaseForm
              key={`${caseId}:${current.version}`}
              current={current}
              recordings={recordings}
              pending={update.isPending}
              onCancel={() => setEditing(false)}
              onSave={(payload: ConsiliumCaseCreate | ConsiliumCaseUpdate) => {
                if ('expected_version' in payload)
                  update.mutate(payload, { onSuccess: () => setEditing(false) })
              }}
            />
          )}
          {preview && (
            <div
              role="dialog"
              aria-label="Удаление исследования"
              className="space-y-2 rounded-lg border border-danger p-3"
            >
              <p>
                Будут удалены: контекст — {preview.context_revisions}, реплики —{' '}
                {preview.message_revisions}, материалы — {preview.evidence_items}, снимки —{' '}
                {preview.snapshots}.
              </p>
              {preview.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
              <Button
                disabled={deletion.isPending}
                onClick={() =>
                  deletion.mutate(preview.version, {
                    onSuccess: () => {
                      queryClient.removeQueries({ queryKey: ['consilium', caseId] })
                      onDeleted()
                    },
                  })
                }
              >
                Удалить исследование окончательно
              </Button>
              <Button disabled={deletion.isPending} onClick={() => setPreview(null)}>
                Отмена
              </Button>
            </div>
          )}
          <SegmentedControl
            label="Рабочая область"
            layout="inline"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'history', label: 'Контекст и история' },
              { value: 'materials', label: 'Материалы и досье' },
            ]}
          />
          {tab === 'history' ? (
            <CaseHistory current={current} />
          ) : (
            <CaseMaterials current={current} />
          )}
        </>
      )}
    </section>
  )
}
