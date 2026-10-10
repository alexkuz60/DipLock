/** Адреса Консилиума; ошибки и транспорт — общие с остальным приложением. */
import { API_PREFIX, request } from './client'
import type {
  ConsiliumCase,
  ConsiliumCaseCreate,
  ConsiliumCaseUpdate,
  ConsiliumCasesPage,
  ConsiliumContext,
  ConsiliumContextCreate,
  ConsiliumContextUpdate,
  ConsiliumContextPage,
  ConsiliumMessage,
  ConsiliumMessageCreate,
  ConsiliumMessageUpdate,
  ConsiliumMessagesPage,
  ConsiliumEvidence,
  ConsiliumEvidenceCreate,
  ConsiliumEvidencePage,
  ConsiliumEvidenceDeletion,
  ConsiliumSnapshot,
  ConsiliumSnapshotCreate,
  ConsiliumSnapshotsPage,
  ConsiliumSourcesPage,
  ConsiliumRecording,
  ConsiliumDeletionPreview,
} from './types'

const base = `${API_PREFIX}/consilium`
const path = (id: string) => `${base}/cases/${encodeURIComponent(id)}`
const page = (offset = 0) => `?limit=20&offset=${offset}`
const json = (method: string, payload: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const consiliumApi = {
  cases: (offset = 0, signal?: AbortSignal) =>
    request<ConsiliumCasesPage>(`${base}/cases${page(offset)}`, { signal }),
  create: (payload: ConsiliumCaseCreate) =>
    request<ConsiliumCase>(`${base}/cases`, json('POST', payload)),
  case: (id: string, signal?: AbortSignal) => request<ConsiliumCase>(path(id), { signal }),
  update: (id: string, payload: ConsiliumCaseUpdate) =>
    request<ConsiliumCase>(path(id), json('PATCH', payload)),
  recordings: (signal?: AbortSignal) =>
    request<ConsiliumRecording[]>(`${base}/recordings`, { signal }),
  context: (id: string, offset = 0, signal?: AbortSignal) =>
    request<ConsiliumContextPage>(`${path(id)}/context${page(offset)}`, { signal }),
  addContext: (id: string, payload: ConsiliumContextCreate) =>
    request<ConsiliumContext>(`${path(id)}/context`, json('POST', payload)),
  editContext: (id: string, entryId: string, payload: ConsiliumContextUpdate) =>
    request<ConsiliumContext>(`${path(id)}/context/${entryId}`, json('PATCH', payload)),
  messages: (id: string, offset = 0, signal?: AbortSignal) =>
    request<ConsiliumMessagesPage>(`${path(id)}/messages${page(offset)}`, { signal }),
  addMessage: (id: string, payload: ConsiliumMessageCreate) =>
    request<ConsiliumMessage>(`${path(id)}/messages`, json('POST', payload)),
  editMessage: (id: string, entryId: string, payload: ConsiliumMessageUpdate) =>
    request<ConsiliumMessage>(`${path(id)}/messages/${entryId}`, json('PATCH', payload)),
  sources: (id: string, offset = 0, signal?: AbortSignal) =>
    request<ConsiliumSourcesPage>(`${path(id)}/sources${page(offset)}`, { signal }),
  evidence: (id: string, offset = 0, signal?: AbortSignal) =>
    request<ConsiliumEvidencePage>(`${path(id)}/evidence${page(offset)}`, { signal }),
  addEvidence: (id: string, payload: ConsiliumEvidenceCreate) =>
    request<ConsiliumEvidence>(`${path(id)}/evidence`, json('POST', payload)),
  snapshots: (id: string, offset = 0, signal?: AbortSignal) =>
    request<ConsiliumSnapshotsPage>(`${path(id)}/snapshots${page(offset)}`, { signal }),
  snapshot: (id: string, snapshotId: string, signal?: AbortSignal) =>
    request<ConsiliumSnapshot>(`${path(id)}/snapshots/${snapshotId}`, { signal }),
  publish: (id: string, payload: ConsiliumSnapshotCreate) =>
    request<ConsiliumSnapshot>(`${path(id)}/snapshots`, json('POST', payload)),
  deletion: (id: string) => request<ConsiliumDeletionPreview>(`${path(id)}/deletion-preview`),
  delete: (id: string, version: number) =>
    request<void>(`${path(id)}?expected_version=${version}`, { method: 'DELETE' }),
  evidenceDeletion: (id: string, evidenceId: string) =>
    request<ConsiliumEvidenceDeletion>(`${path(id)}/evidence/${evidenceId}/deletion-preview`),
  deleteEvidence: (id: string, evidenceId: string, version: number) =>
    request<void>(`${path(id)}/evidence/${evidenceId}?expected_version=${version}`, {
      method: 'DELETE',
    }),
}
