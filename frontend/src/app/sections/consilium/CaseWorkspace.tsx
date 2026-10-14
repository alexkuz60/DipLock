/** Выбранное дело: ключ компонента отделяет поздние ответы другого исследования. */
import { useEffect, useState } from 'react'
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
import { useConsiliumOptions } from '@/shared/state/consiliumOptions'
import { CaseForm } from './CaseForm'
import { CaseHistory } from './CaseHistory'
import { CaseLibrary } from './CaseLibrary'
import { CaseMaterials } from './CaseMaterials'
import { CaseDiscussion } from './CaseDiscussion'
import { CaseSidebar } from './CaseSidebar'
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
  const [tab, setTab] = useState<'discussion' | 'history' | 'materials' | 'library'>('discussion')
  const [editing, setEditing] = useState(false)
  const [preview, setPreview] = useState<ConsiliumDeletionPreview | null>(null)
  // Левая панель (срез 0015) и переход к якорю дерева навигации
  const sidebarOpen = useConsiliumOptions((state) => state.sidebar.open)
  const setSidebarOpen = useConsiliumOptions((state) => state.setSidebarOpen)
  const [jump, setJump] = useState<string | null>(null)
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

  /** Переход дерева навигации: показать «Обсуждение» и прокрутить к карточке. */
  function navigateTo(target: string) {
    setTab('discussion')
    setJump(target)
  }

  // Прокрутка к якорю выполняется, когда карточка смонтирована: лента раундов
  // может догружаться, поэтому поиск повторяется до находки якоря (guard jsdom).
  useEffect(() => {
    if (!jump) return
    let cancelled = false
    let attempts = 0
    const tryJump = () => {
      if (cancelled) return
      const el = document.getElementById(jump)
      if (!el) {
        attempts += 1
        if (attempts < 100) window.setTimeout(tryJump, 50)
        return
      }
      if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' })
      el.classList.add('ring-2', 'ring-accent')
      window.setTimeout(() => el.classList.remove('ring-2', 'ring-accent'), 1500)
      setJump(null)
    }
    tryJump()
    return () => {
      cancelled = true
    }
  }, [jump])

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
                {preview.snapshots}, раунды советников — {preview.rounds}, ответы —{' '}
                {preview.answers}, переписки консультаций — {preview.chat_messages ?? 0}.
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
          <div className="flex gap-4">
            {sidebarOpen && <CaseSidebar current={current} onJump={navigateTo} />}
            <div className="min-w-0 flex-1 space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <SegmentedControl
                  label="Рабочая область"
                  layout="inline"
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: 'discussion', label: 'Обсуждение' },
                    { value: 'history', label: 'Контекст и история' },
                    { value: 'materials', label: 'Материалы и досье' },
                    { value: 'library', label: 'Библиотека' },
                  ]}
                />
                {!sidebarOpen && (
                  <Button variant="ghost" onClick={() => setSidebarOpen(true)}>
                    Показать левую панель
                  </Button>
                )}
              </div>
              {tab === 'discussion' ? (
                <CaseDiscussion current={current} />
              ) : tab === 'history' ? (
                <CaseHistory current={current} />
              ) : tab === 'library' ? (
                <CaseLibrary current={current} />
              ) : (
                <CaseMaterials current={current} />
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}
