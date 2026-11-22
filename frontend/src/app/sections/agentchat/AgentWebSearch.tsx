/**
 * Веб-поиск Архивариуса: запрос уходит поисковику только по кнопке «Найти»,
 * перевод найденного — отдельной кнопкой; поиски сохраняются в нити и
 * подмешиваются в контекст роли.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { agentChatApi } from '@/shared/api/agentChat'
import { apiErrorText } from '@/shared/api/client'
import type { AgentWebSearch as AgentWebSearchItem } from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { TextField } from '@/shared/ui/TextField'

function SearchCard({
  item,
  translating,
  onTranslate,
}: {
  item: AgentWebSearchItem
  translating: boolean
  onTranslate: () => void
}) {
  return (
    <article className="space-y-1 rounded-lg border border-border bg-bg-2 p-2">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-fg-0">{item.query}</span>
        <span className="text-fg-2">{new Date(item.created_at).toLocaleString('ru')}</span>
        <span className="text-fg-2">
          {item.translated ? 'перевод есть' : 'без перевода'}
        </span>
      </header>
      {item.results.length === 0 ? (
        <p className="text-sm text-fg-2">Ничего не найдено.</p>
      ) : (
        <ul className="space-y-1">
          {item.results.map((result) => (
            <li key={result.url} className="text-sm">
              <a
                className="text-accent underline"
                href={result.url}
                target="_blank"
                rel="noreferrer"
              >
                {result.title_ru ?? result.title}
              </a>
              {result.title_ru && <span className="text-fg-2"> ({result.title})</span>}
              <p className="whitespace-pre-wrap text-fg-1">
                {result.snippet_ru ?? result.snippet}
              </p>
              {result.error && <p className="text-danger">{result.error}</p>}
            </li>
          ))}
        </ul>
      )}
      {!item.translated && item.results.length > 0 && (
        <Button disabled={translating} onClick={onTranslate}>
          Перевести на русский
        </Button>
      )}
    </article>
  )
}

export function AgentWebSearch({ threadId }: { threadId: string }) {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const key = ['agent-chat', 'web-search', threadId]

  const searches = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => agentChatApi.webSearches(threadId, signal),
    enabled: !!threadId,
  })
  const search = useMutation({
    mutationFn: (text: string) => agentChatApi.webSearch(threadId, { query: text }),
    onSuccess: async () => {
      setQuery('')
      await queryClient.invalidateQueries({ queryKey: key })
    },
  })
  const translate = useMutation({
    mutationFn: (searchId: string) => agentChatApi.translateWebSearch(threadId, searchId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  })

  const items = searches.data?.items ?? []

  return (
    <details className="rounded-lg border border-border bg-bg-1 p-2">
      <summary className="cursor-pointer text-fg-0">Веб-поиск для Архивариуса</summary>
      <div className="mt-2 space-y-2">
        <p className="text-sm text-fg-2">
          Запрос уходит поисковику (DuckDuckGo) только по кнопке «Найти»; найденный
          текст переводится провайдером роли только по кнопке «Перевести на русский».
          Не ищите персональные данные добровольцев.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <TextField
              label="Поисковый запрос"
              value={query}
              onChange={setQuery}
              placeholder="Например: EEG microstates depression review"
            />
          </div>
          <Button
            variant="primary"
            disabled={search.isPending || !query.trim()}
            onClick={() => search.mutate(query.trim())}
          >
            Найти
          </Button>
        </div>
        {search.error != null && <ErrorBlock message={apiErrorText(search.error)} />}
        {translate.error != null && <ErrorBlock message={apiErrorText(translate.error)} />}
        {searches.isPending && <LoadingBlock label="Загрузка поисков..." />}
        {searches.error != null && <ErrorBlock message={apiErrorText(searches.error)} />}
        {items.length === 0 && !searches.isPending && (
          <p className="text-sm text-fg-2">В этой нити ещё не было веб-поиска.</p>
        )}
        <div className="space-y-2">
          {items.map((item) => (
            <SearchCard
              key={item.id}
              item={item}
              translating={translate.isPending}
              onTranslate={() => translate.mutate(item.id)}
            />
          ))}
        </div>
      </div>
    </details>
  )
}
