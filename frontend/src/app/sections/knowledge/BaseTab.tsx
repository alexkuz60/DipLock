/**
 * «База знаний»: поиск по фрагментам, теги и граф подтверждённых связей.
 *
 * Режим поиска показывается честно: `hybrid` — работали эмбеддинги,
 * `tfidf` — провайдер недоступен, поиск только лексический.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiErrorText } from '@/shared/api/client'
import { knowledgeApi } from '@/shared/api/knowledge'
import { Button } from '@/shared/ui/Button'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { TextField } from '@/shared/ui/TextField'
import { GraphView } from './GraphView'

const MODE_LABEL: Record<string, string> = {
  hybrid: 'семантика + лексика',
  tfidf: 'только лексика (эмбеддинги недоступны)',
}

export function BaseTab() {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [tagName, setTagName] = useState('')

  const search = useQuery({
    queryKey: ['knowledge', 'search', submitted],
    queryFn: ({ signal }) => knowledgeApi.search(submitted, signal),
    enabled: submitted.length > 0,
  })
  const tags = useQuery({
    queryKey: ['knowledge', 'tags'],
    queryFn: ({ signal }) => knowledgeApi.tags(signal),
  })
  const graph = useQuery({
    queryKey: ['knowledge', 'graph'],
    queryFn: ({ signal }) => knowledgeApi.graph(signal),
  })
  const createTag = useMutation({
    mutationFn: (name: string) => knowledgeApi.createTag(name),
    onSuccess: async () => {
      setTagName('')
      await queryClient.invalidateQueries({ queryKey: ['knowledge'] })
    },
  })

  const error = search.error ?? tags.error ?? graph.error ?? createTag.error

  return (
    <div className="space-y-4">
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-fg-0">Поиск по библиотеке</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <TextField
              label="Запрос"
              value={query}
              onChange={setQuery}
              placeholder="микросостояния депрессия"
            />
          </div>
          <Button
            variant="primary"
            disabled={!query.trim()}
            onClick={() => setSubmitted(query.trim())}
          >
            Искать
          </Button>
        </div>
        {error != null && <ErrorBlock message={apiErrorText(error)} />}
        {search.isFetching && <LoadingBlock label="Поиск..." />}
        {search.data && (
          <>
            <p className="text-xs text-fg-2">
              Режим: {MODE_LABEL[search.data.mode] ?? search.data.mode} · найдено{' '}
              {search.data.hits.length}
            </p>
            <ul className="space-y-2">
              {search.data.hits.map((hit) => (
                <li
                  key={hit.chunk_id}
                  className="rounded-lg border border-border bg-bg-1 p-2"
                >
                  <p className="text-sm font-medium text-fg-0">
                    {hit.document_title}
                    {hit.heading && <span className="text-fg-2"> · {hit.heading}</span>}
                    <span className="ml-2 text-xs text-fg-2">
                      {hit.score.toFixed(3)}
                    </span>
                  </p>
                  <p className="whitespace-pre-wrap text-sm text-fg-1">{hit.text}</p>
                </li>
              ))}
              {search.data.hits.length === 0 && (
                <li className="text-sm text-fg-2">Ничего не найдено.</li>
              )}
            </ul>
          </>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-fg-0">Теги</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1">
            <TextField label="Новый тег" value={tagName} onChange={setTagName} />
          </div>
          <Button
            disabled={!tagName.trim() || createTag.isPending}
            onClick={() => createTag.mutate(tagName.trim())}
          >
            Создать тег
          </Button>
        </div>
        <ul className="flex flex-wrap gap-2">
          {(tags.data?.items ?? []).map((tag) => (
            <li
              key={tag.id}
              className="rounded-full border border-border bg-bg-2 px-2 py-1 text-xs text-fg-1"
            >
              {tag.name} · {tag.documents}
            </li>
          ))}
          {(tags.data?.items ?? []).length === 0 && (
            <li className="text-sm text-fg-2">Тегов пока нет.</li>
          )}
        </ul>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-fg-0">Граф знаний</h3>
        <p className="text-xs text-fg-2">
          В граф входят только подтверждённые связи; предложенные ИИ рёбра
          показываются отдельно и в граф не попадают.
        </p>
        {graph.isPending && <LoadingBlock label="Загрузка графа..." />}
        {graph.data && <GraphView graph={graph.data} />}
      </section>
    </div>
  )
}
