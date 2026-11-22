/** Раздел Т1: ручные исследования, контекст, выбранные материалы и снимки досье. */
import { lazy, Suspense, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { consiliumApi } from '@/shared/api/consilium'
import { apiErrorText } from '@/shared/api/client'
import type { ConsiliumCaseCreate, ConsiliumCaseUpdate } from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { CaseForm } from './CaseForm'
import { CaseWorkspace } from './CaseWorkspace'
import { PageButtons, QueryState } from './common'

function ConsiliumResearchView() {
  const [params, setParams] = useSearchParams()
  const caseId = params.get('case') ?? ''
  const [offset, setOffset] = useState(0)
  const [creating, setCreating] = useState(false)
  const queryClient = useQueryClient()
  const cases = useQuery({
    queryKey: ['consilium-cases', offset],
    queryFn: ({ signal }) => consiliumApi.cases(offset, signal),
    gcTime: 0,
  })
  const recordings = useQuery({
    queryKey: ['consilium-recordings'],
    queryFn: ({ signal }) => consiliumApi.recordings(signal),
    gcTime: 0,
  })

  function select(id: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous)
      if (id) next.set('case', id)
      else next.delete('case')
      return next
    })
    setCreating(false)
  }

  const create = useMutation({
    mutationFn: (payload: ConsiliumCaseCreate) => consiliumApi.create(payload),
    retry: false,
    gcTime: 0,
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['consilium-cases'] })
      select(created.id)
    },
  })

  return (
    <div className="space-y-4 p-4">
      <p className="text-fg-2">
        Материалы дела и снимки формируются вручную; общий чат экспертов не получает их автоматически.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={() => {
            setCreating(true)
            create.reset()
          }}
        >
          Новое исследование
        </Button>
        <Button
          onClick={() => {
            void cases.refetch()
            void recordings.refetch()
          }}
        >
          Обновить список
        </Button>
      </div>
      <QueryState
        loading={cases.isPending}
        error={cases.error}
        retry={() => {
          void cases.refetch()
        }}
      />
      <QueryState
        loading={recordings.isPending}
        error={recordings.error}
        retry={() => {
          void recordings.refetch()
        }}
      />
      {cases.data && (
        <>
          <nav aria-label="Исследования" className="flex flex-wrap gap-2">
            {cases.data.items.map((item) => (
              <Button
                key={item.id}
                variant={caseId === item.id ? 'primary' : 'secondary'}
                onClick={() => select(item.id)}
              >
                {item.title}
                {item.status === 'archived' ? ' · архив' : ''}
              </Button>
            ))}
          </nav>
          {!cases.data.total && !creating && (
            <p>Исследований пока нет. Начните с вопроса, который хотите прояснить.</p>
          )}
          <PageButtons offset={offset} total={cases.data.total} onChange={setOffset} />
        </>
      )}
      {create.error && (
        <ErrorBlock
          message={apiErrorText(create.error)}
          onRetry={() => {
            if (create.variables) create.mutate(create.variables)
          }}
        />
      )}
      {creating && (
        <CaseForm
          recordings={recordings.data ?? []}
          pending={create.isPending}
          onCancel={() => setCreating(false)}
          onSave={(payload: ConsiliumCaseCreate | ConsiliumCaseUpdate) => create.mutate(payload)}
        />
      )}
      {caseId && !creating && (
        <CaseWorkspace
          key={caseId}
          caseId={caseId}
          recordings={recordings.data ?? []}
          onDeleted={() => select('')}
        />
      )}
    </div>
  )
}


const AgentChatView = lazy(() =>
  import('../agentchat/AgentChatSection').then(({ AgentChatSection }) => ({
    default: AgentChatSection,
  })),
)

const KnowledgeView = lazy(() =>
  import('../knowledge/KnowledgeSection').then(({ KnowledgeSection }) => ({
    default: KnowledgeSection,
  })),
)

/** Раздел сохраняет ручное исследование Т1 и добавляет рядом общий чат экспертов. */
export function ConsiliumSection() {
  const [params, setParams] = useSearchParams()
  const raw = params.get('view')
  const view = raw === 'chat' ? 'chat' : raw === 'knowledge' ? 'knowledge' : 'research'

  function selectView(nextView: 'research' | 'chat' | 'knowledge') {
    setParams((previous) => {
      const next = new URLSearchParams(previous)
      if (nextView === 'research') next.delete('view')
      else next.set('view', nextView)
      return next
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav aria-label="Разделы Консилиума" className="flex shrink-0 gap-2 border-b border-border p-3">
        <Button
          variant={view === 'research' ? 'primary' : 'secondary'}
          aria-pressed={view === 'research'}
          onClick={() => selectView('research')}
        >
          Исследование
        </Button>
        <Button
          variant={view === 'chat' ? 'primary' : 'secondary'}
          aria-pressed={view === 'chat'}
          onClick={() => selectView('chat')}
        >
          Чат экспертов
        </Button>
        <Button
          variant={view === 'knowledge' ? 'primary' : 'secondary'}
          aria-pressed={view === 'knowledge'}
          onClick={() => selectView('knowledge')}
        >
          Знания
        </Button>
      </nav>
      {view === 'chat' ? (
        <Suspense fallback={<LoadingBlock label="Загрузка чата экспертов..." />}>
          <AgentChatView />
        </Suspense>
      ) : view === 'knowledge' ? (
        <Suspense fallback={<LoadingBlock label="Загрузка знаний..." />}>
          <KnowledgeView />
        </Suspense>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <ConsiliumResearchView />
        </div>
      )}
    </div>
  )
}
