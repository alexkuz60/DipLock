/**
 * Раздел «Знания» Консилиума: подвкладки «Источники» и «База знаний».
 *
 * Источники — файлы и чтение (папки, загрузка, оглавление, аннотации, теги).
 * База знаний — поиск и связи (фрагменты, теги, граф). Разделение по `?tab=`
 * даёт прямые ссылки и не смешивает две разные задачи в одном экране.
 */
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/shared/ui/Button'
import { BaseTab } from './BaseTab'
import { SourcesTab } from './SourcesTab'

export function KnowledgeSection() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'base' ? 'base' : 'sources'

  function selectTab(next: 'sources' | 'base') {
    setParams((previous) => {
      const copy = new URLSearchParams(previous)
      if (next === 'base') copy.set('tab', 'base')
      else copy.delete('tab')
      return copy
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <nav
        aria-label="Подразделы знаний"
        className="flex shrink-0 gap-2 border-b border-border p-3"
      >
        <Button
          variant={tab === 'sources' ? 'primary' : 'secondary'}
          aria-pressed={tab === 'sources'}
          onClick={() => selectTab('sources')}
        >
          Источники
        </Button>
        <Button
          variant={tab === 'base' ? 'primary' : 'secondary'}
          aria-pressed={tab === 'base'}
          onClick={() => selectTab('base')}
        >
          База знаний
        </Button>
      </nav>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === 'base' ? <BaseTab /> : <SourcesTab />}
      </div>
    </div>
  )
}
