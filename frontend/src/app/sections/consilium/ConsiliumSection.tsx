/** Раздел «Консилиум»: чат экспертов и База знаний. Режим «Исследование» удалён 23.11.2026. */
import { lazy, Suspense } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/shared/ui/Button'
import { LoadingBlock } from '@/shared/ui/StateViews'

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

/** Две вкладки раздела: общий чат ролевых агентов и библиотека знаний. */
export function ConsiliumSection() {
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'knowledge' ? 'knowledge' : 'chat'

  function selectView(nextView: 'chat' | 'knowledge') {
    setParams((previous) => {
      const next = new URLSearchParams(previous)
      if (nextView === 'chat') next.delete('view')
      else next.set('view', nextView)
      return next
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav aria-label="Разделы Консилиума" className="flex shrink-0 gap-2 border-b border-border p-3">
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
      {view === 'knowledge' ? (
        <Suspense fallback={<LoadingBlock label="Загрузка знаний..." />}>
          <KnowledgeView />
        </Suspense>
      ) : (
        <Suspense fallback={<LoadingBlock label="Загрузка чата экспертов..." />}>
          <AgentChatView />
        </Suspense>
      )}
    </div>
  )
}
