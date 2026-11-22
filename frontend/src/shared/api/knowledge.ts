/** Адреса библиотеки знаний Консилиума: источники, поиск, теги, граф, вложения. */
import { API_PREFIX, request } from './client'
import type {
  AgentAttachment,
  AgentAttachmentCreate,
  AgentAttachmentsPage,
  KnowledgeAnnotation,
  KnowledgeAnnotationCreate,
  KnowledgeDocument,
  KnowledgeDocumentDetail,
  KnowledgeDocumentsPage,
  KnowledgeDocTagsUpdate,
  KnowledgeFolder,
  KnowledgeFolderCreate,
  KnowledgeFoldersPage,
  KnowledgeGraph,
  KnowledgeLink,
  KnowledgeLinkCreate,
  KnowledgeSearch,
  KnowledgeTag,
  KnowledgeTagsPage,
  KnowledgeWebAdd,
} from './types'

const base = `${API_PREFIX}/knowledge`
const json = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})
const doc = (id: string) => `${base}/documents/${encodeURIComponent(id)}`

export const knowledgeApi = {
  folders: (signal?: AbortSignal) => request<KnowledgeFoldersPage>(`${base}/folders`, { signal }),
  createFolder: (payload: KnowledgeFolderCreate) =>
    request<KnowledgeFolder>(`${base}/folders`, json('POST', payload)),
  deleteFolder: (id: string) =>
    request<void>(`${base}/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  documents: (folderId: string | null, signal?: AbortSignal) => {
    const query = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : ''
    return request<KnowledgeDocumentsPage>(`${base}/documents${query}`, { signal })
  },
  upload: (file: File, folderId: string | null, title?: string) => {
    const body = new FormData()
    body.append('file', file)
    if (folderId) body.append('folder_id', folderId)
    if (title) body.append('title', title)
    return request<KnowledgeDocument>(`${base}/documents`, { method: 'POST', body })
  },
  addWeb: (payload: KnowledgeWebAdd) =>
    request<KnowledgeDocument>(`${base}/documents/web`, json('POST', payload)),
  document: (id: string, signal?: AbortSignal) =>
    request<KnowledgeDocumentDetail>(doc(id), { signal }),
  deleteDocument: (id: string) => request<void>(doc(id), { method: 'DELETE' }),

  addAnnotation: (id: string, payload: KnowledgeAnnotationCreate) =>
    request<KnowledgeAnnotation>(`${doc(id)}/annotations`, json('POST', payload)),
  deleteAnnotation: (annotationId: string) =>
    request<void>(`${base}/annotations/${encodeURIComponent(annotationId)}`, {
      method: 'DELETE',
    }),
  setTags: (id: string, payload: KnowledgeDocTagsUpdate) =>
    request<string[]>(`${doc(id)}/tags`, json('PUT', payload)),

  tags: (signal?: AbortSignal) => request<KnowledgeTagsPage>(`${base}/tags`, { signal }),
  createTag: (name: string) =>
    request<KnowledgeTag>(`${base}/tags`, json('POST', { name })),

  search: (query: string, signal?: AbortSignal) =>
    request<KnowledgeSearch>(`${base}/search?q=${encodeURIComponent(query)}`, { signal }),
  graph: (signal?: AbortSignal) => request<KnowledgeGraph>(`${base}/graph`, { signal }),
  createLink: (payload: KnowledgeLinkCreate) =>
    request<KnowledgeLink>(`${base}/links`, json('POST', payload)),
  deleteLink: (id: string) =>
    request<void>(`${base}/links/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  attachments: (threadId: string, signal?: AbortSignal) =>
    request<AgentAttachmentsPage>(
      `${base}/threads/${encodeURIComponent(threadId)}/attachments`,
      { signal },
    ),
  attach: (threadId: string, payload: AgentAttachmentCreate) =>
    request<AgentAttachment>(
      `${base}/threads/${encodeURIComponent(threadId)}/attachments`,
      json('POST', payload),
    ),
  detach: (attachmentId: string) =>
    request<void>(`${base}/attachments/${encodeURIComponent(attachmentId)}`, {
      method: 'DELETE',
    }),
}
