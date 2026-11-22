/**
 * Читалка документа: оглавление по разделам, аннотации и теги.
 *
 * Аннотация привязывается к фрагменту (разделу) — так заметка не теряет
 * контекст при повторном открытии документа.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiErrorText } from '@/shared/api/client'
import { knowledgeApi } from '@/shared/api/knowledge'
import { Button } from '@/shared/ui/Button'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { TextField } from '@/shared/ui/TextField'

export function DocumentReader({
  documentId,
  onDeleted,
}: {
  documentId: string
  onDeleted: () => void
}) {
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')
  const [chunkId, setChunkId] = useState<string | null>(null)
  const [tags, setTags] = useState('')

  const detail = useQuery({
    queryKey: ['knowledge', 'document', documentId],
    queryFn: ({ signal }) => knowledgeApi.document(documentId, signal),
  })

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['knowledge'] })

  const addNote = useMutation({
    mutationFn: () =>
      knowledgeApi.addAnnotation(documentId, {
        note: note.trim(),
        chunk_id: chunkId,
        heading:
          detail.data?.chunks.find((chunk) => chunk.id === chunkId)?.heading ?? null,
      }),
    onSuccess: async () => {
      setNote('')
      await invalidate()
    },
  })
  const saveTags = useMutation({
    mutationFn: (names: string[]) =>
      knowledgeApi.setTags(documentId, {
        tags: names.map((name) => name.trim()).filter(Boolean),
      }),
    onSuccess: async () => {
      setTags('')
      await invalidate()
    },
  })
  const remove = useMutation({
    mutationFn: () => knowledgeApi.deleteDocument(documentId),
    onSuccess: async () => {
      await invalidate()
      onDeleted()
    },
  })

  if (detail.isPending) return <LoadingBlock label="Загрузка документа..." />
  if (detail.error != null) return <ErrorBlock message={apiErrorText(detail.error)} />

  const { document, chunks, annotations } = detail.data
  const error = addNote.error ?? saveTags.error ?? remove.error

  return (
    <div className="space-y-3">
      <header className="space-y-1">
        <h3 className="text-base font-medium text-fg-0">{document.title}</h3>
        <p className="text-xs text-fg-2">
          {document.kind} · {document.pages ?? '—'} стр. · {document.text_chars} символов ·{' '}
          {document.chunks} фрагментов
        </p>
        {document.source_url && (
          <a
            className="text-xs text-accent underline"
            href={document.source_url}
            target="_blank"
            rel="noreferrer"
          >
            {document.source_url}
          </a>
        )}
        {document.error && <p className="text-sm text-warn">{document.error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-fg-2">
            Теги: {document.tags.length ? document.tags.join(', ') : 'нет'}
          </span>
          <Button variant="ghost" onClick={() => remove.mutate()}>
            Удалить документ
          </Button>
        </div>
      </header>

      {error != null && <ErrorBlock message={apiErrorText(error)} />}

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <TextField
            label="Теги через запятую"
            value={tags}
            onChange={setTags}
            placeholder="ЭЭГ, микросостояния"
          />
        </div>
        <Button
          disabled={!tags.trim() || saveTags.isPending}
          onClick={() => saveTags.mutate(tags.split(','))}
        >
          Сохранить теги
        </Button>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-fg-0">Оглавление</h4>
        {chunks.length === 0 && (
          <p className="text-sm text-fg-2">
            Текстовых фрагментов нет: у документа нет текстового слоя.
          </p>
        )}
        <ol className="space-y-2">
          {chunks.map((chunk) => (
            <li
              key={chunk.id}
              className={
                chunkId === chunk.id
                  ? 'rounded-lg border border-accent bg-bg-2 p-2'
                  : 'rounded-lg border border-border bg-bg-1 p-2'
              }
            >
              <button
                type="button"
                className="w-full text-left text-sm font-medium text-fg-0"
                onClick={() => setChunkId(chunk.id === chunkId ? null : chunk.id)}
              >
                {chunk.heading ?? `Фрагмент ${chunk.ordinal + 1}`}
                {chunk.page_from != null && (
                  <span className="ml-2 text-xs text-fg-2">стр. {chunk.page_from}</span>
                )}
              </button>
              <p className="mt-1 whitespace-pre-wrap text-sm text-fg-1">{chunk.text}</p>
            </li>
          ))}
        </ol>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-fg-0">Аннотации</h4>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1">
            <TextField
              label={chunkId ? 'Заметка к выбранному разделу' : 'Заметка к документу'}
              value={note}
              onChange={setNote}
            />
          </div>
          <Button
            disabled={!note.trim() || addNote.isPending}
            onClick={() => addNote.mutate()}
          >
            Добавить аннотацию
          </Button>
        </div>
        <ul className="space-y-1">
          {annotations.map((annotation) => (
            <li key={annotation.id} className="text-sm text-fg-1">
              {annotation.heading && (
                <span className="text-fg-2">{annotation.heading}: </span>
              )}
              {annotation.note}
            </li>
          ))}
          {annotations.length === 0 && (
            <li className="text-sm text-fg-2">Аннотаций пока нет.</li>
          )}
        </ul>
      </div>
    </div>
  )
}
