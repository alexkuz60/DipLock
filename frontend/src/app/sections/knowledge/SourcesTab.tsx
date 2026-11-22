/**
 * «Источники»: папки библиотеки, загрузка файлов и веб-ссылок, список
 * документов и читалка с оглавлением по разделам.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { apiErrorText } from '@/shared/api/client'
import { knowledgeApi } from '@/shared/api/knowledge'
import type { KnowledgeDocument } from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { TextField } from '@/shared/ui/TextField'
import { DocumentReader } from './DocumentReader'

const STATUS_LABEL: Record<string, string> = {
  ok: 'текст извлечён',
  empty: 'текста нет',
  failed: 'разбор не удался',
}

export function SourcesTab() {
  const queryClient = useQueryClient()
  const [folderId, setFolderId] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [folderName, setFolderName] = useState('')
  const [webUrl, setWebUrl] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)

  const folders = useQuery({
    queryKey: ['knowledge', 'folders'],
    queryFn: ({ signal }) => knowledgeApi.folders(signal),
  })
  const documents = useQuery({
    queryKey: ['knowledge', 'documents', folderId],
    queryFn: ({ signal }) => knowledgeApi.documents(folderId, signal),
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['knowledge'] })

  const createFolder = useMutation({
    mutationFn: (name: string) => knowledgeApi.createFolder({ name, parent_id: null }),
    onSuccess: async () => {
      setFolderName('')
      await invalidate()
    },
  })
  const deleteFolder = useMutation({
    mutationFn: (id: string) => knowledgeApi.deleteFolder(id),
    onSuccess: async () => {
      setFolderId(null)
      await invalidate()
    },
  })
  const upload = useMutation({
    mutationFn: (file: File) => knowledgeApi.upload(file, folderId),
    onSuccess: async (document) => {
      setSelected(document.id)
      await invalidate()
    },
  })
  const addWeb = useMutation({
    mutationFn: (url: string) => knowledgeApi.addWeb({ url, folder_id: folderId }),
    onSuccess: async (document) => {
      setWebUrl('')
      setSelected(document.id)
      await invalidate()
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => knowledgeApi.deleteDocument(id),
    onSuccess: async () => {
      setSelected(null)
      await invalidate()
    },
  })

  const items = documents.data?.items ?? []
  const error =
    folders.error ?? documents.error ?? upload.error ?? addWeb.error ?? remove.error

  return (
    <div className="grid gap-3 lg:grid-cols-[220px_minmax(0,1fr)_minmax(0,1.2fr)]">
      <aside className="space-y-2">
        <h3 className="text-sm font-medium text-fg-0">Папки</h3>
        <Button
          variant={folderId === null ? 'primary' : 'secondary'}
          onClick={() => setFolderId(null)}
        >
          Все документы
        </Button>
        <ul className="space-y-1">
          {(folders.data?.items ?? []).map((folder) => (
            <li key={folder.id} className="flex items-center gap-1">
              <Button
                variant={folderId === folder.id ? 'primary' : 'secondary'}
                onClick={() => setFolderId(folder.id)}
              >
                {folder.name} ({folder.documents})
              </Button>
              <Button
                variant="ghost"
                aria-label={`Удалить папку ${folder.name}`}
                onClick={() => deleteFolder.mutate(folder.id)}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
        <div className="space-y-1 border-t border-border pt-2">
          <TextField label="Новая папка" value={folderName} onChange={setFolderName} />
          <Button
            disabled={!folderName.trim() || createFolder.isPending}
            onClick={() => createFolder.mutate(folderName.trim())}
          >
            Создать папку
          </Button>
        </div>
      </aside>

      <section className="space-y-2">
        <h3 className="text-sm font-medium text-fg-0">Документы</h3>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            aria-label="Файл библиотеки"
            className="text-sm text-fg-1"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) upload.mutate(file)
              event.target.value = ''
            }}
          />
          {upload.isPending && <LoadingBlock label="Разбор файла..." />}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1">
            <TextField
              label="Веб-ссылка"
              value={webUrl}
              onChange={setWebUrl}
              placeholder="https://..."
            />
          </div>
          <Button
            disabled={!webUrl.trim().startsWith('http') || addWeb.isPending}
            onClick={() => addWeb.mutate(webUrl.trim())}
          >
            Добавить страницу
          </Button>
        </div>
        <p className="text-xs text-fg-2">
          PDF с текстовым слоем, DOCX, XLSX, изображения и веб-страницы. Сканы без
          текстового слоя сохраняются, но не индексируются (OCR не подключён).
        </p>
        {error != null && <ErrorBlock message={apiErrorText(error)} />}
        {documents.isPending && <LoadingBlock label="Загрузка документов..." />}
        {items.length === 0 && !documents.isPending && (
          <p className="text-sm text-fg-2">В этой папке пока нет документов.</p>
        )}
        <ul className="space-y-1">
          {items.map((document: KnowledgeDocument) => (
            <li key={document.id} className="flex flex-wrap items-center gap-2 text-sm">
              <Button
                variant={selected === document.id ? 'primary' : 'secondary'}
                onClick={() => setSelected(document.id)}
              >
                {document.title}
              </Button>
              <span className="text-fg-2">
                {document.kind} · {STATUS_LABEL[document.status] ?? document.status} ·{' '}
                {document.chunks} фрагм.
              </span>
              <Button
                variant="ghost"
                aria-label={`Удалить документ ${document.title}`}
                onClick={() => remove.mutate(document.id)}
              >
                ×
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <section className="min-w-0">
        {selected ? (
          <DocumentReader documentId={selected} onDeleted={() => setSelected(null)} />
        ) : (
          <p className="text-sm text-fg-2">Выберите документ, чтобы открыть оглавление.</p>
        )}
      </section>
    </div>
  )
}
