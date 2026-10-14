/** Адреса Консилиума; ошибки и транспорт — общие с остальным приложением. */
import { API_PREFIX, request } from './client'
import type {
  ConsiliumCase,
  ConsiliumCaseCreate,
  ConsiliumCaseUpdate,
  ConsiliumCasesPage,
  ConsiliumChatMessage,
  ConsiliumChatMessageCreate,
  ConsiliumChatMessageRetry,
  ConsiliumChatMessagesPage,
  ConsiliumChatsPage,
  ConsiliumChatSend,
  ConsiliumContext,
  ConsiliumContextCreate,
  ConsiliumContextUpdate,
  ConsiliumContextPage,
  ConsiliumMessage,
  ConsiliumMessageCreate,
  ConsiliumMessageUpdate,
  ConsiliumMessagesPage,
  ConsiliumRound,
  ConsiliumRoundAction,
  ConsiliumRoundCreate,
  ConsiliumRoundsPage,
  ConsiliumAnswerRetry,
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
  ConsiliumTriage,
  ConsiliumTriageCreate,
  ConsiliumTriagePage,
  ConsiliumJevMark,
  ConsiliumJevMarkAnswerCreate,
  ConsiliumJevMarksPage,
  ConsiliumJevMarkRoundPlanCreate,
  ConsiliumBrainstorm,
  ConsiliumBrainstormCreate,
  ConsiliumBrainstormsPage,
  ConsiliumDecision,
  ConsiliumDecisionCreate,
  ConsiliumExecution,
  ConsiliumExecutionCreate,
  ConsiliumProposal,
  ConsiliumProposalCreate,
  ConsiliumProposalsPage,
  ConsiliumProposalUpdate,
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
  rounds: (id: string, offset = 0, signal?: AbortSignal) =>
    request<ConsiliumRoundsPage>(`${path(id)}/rounds${page(offset)}`, { signal }),
  round: (id: string, roundId: string, signal?: AbortSignal) =>
    request<ConsiliumRound>(`${path(id)}/rounds/${roundId}`, { signal }),
  startRound: (id: string, payload: ConsiliumRoundCreate) =>
    request<ConsiliumRound>(`${path(id)}/rounds`, json('POST', payload)),
  runSummary: (id: string, roundId: string, payload: ConsiliumRoundAction) =>
    request<ConsiliumRound>(`${path(id)}/rounds/${roundId}/summary`, json('POST', payload)),
  retryAnswer: (id: string, roundId: string, payload: ConsiliumAnswerRetry) =>
    request<ConsiliumRound>(`${path(id)}/rounds/${roundId}/retry`, json('POST', payload)),
  /** История триажа досье (Jev): append-only, новые сверху. */
  triage: (id: string, offset = 0, signal?: AbortSignal) =>
    request<ConsiliumTriagePage>(`${path(id)}/triage${page(offset)}`, { signal }),
  /** Запуск триажа решающим классификатором — только явной кнопкой. */
  runTriage: (id: string, payload: ConsiliumTriageCreate) =>
    request<ConsiliumTriage>(`${path(id)}/triage`, json('POST', payload)),
  /** «Быстрый раунд»: подбор ролей и глубины по снимку — только кнопкой. */
  runRoundPlan: (id: string, payload: ConsiliumJevMarkRoundPlanCreate) =>
    request<ConsiliumJevMark>(`${path(id)}/jev-marks/round-plan`, json('POST', payload)),
  /** Карточка предложения из текста ответа советника — только кнопкой. */
  runProposalMark: (id: string, payload: ConsiliumJevMarkAnswerCreate) =>
    request<ConsiliumJevMark>(`${path(id)}/jev-marks/proposal`, json('POST', payload)),
  /** Разметка источников утверждений текста ответа — только кнопкой. */
  runSourceMarks: (id: string, payload: ConsiliumJevMarkAnswerCreate) =>
    request<ConsiliumJevMark>(`${path(id)}/jev-marks/source-marks`, json('POST', payload)),
  /** История разметки Jev (append-only) с фильтрами по виду и предмету. */
  jevMarks: (id: string, kind?: string, subjectId?: string, signal?: AbortSignal) => {
    const params = new URLSearchParams({ limit: '20', offset: '0' })
    if (kind) params.set('kind', kind)
    if (subjectId) params.set('subject_id', subjectId)
    return request<ConsiliumJevMarksPage>(`${path(id)}/jev-marks?${params}`, { signal })
  },
  /** Мозговой штурм (срез 0012): история запусков, запуск кнопкой, точная строка. */
  brainstorms: (id: string, offset = 0, signal?: AbortSignal) =>
    request<ConsiliumBrainstormsPage>(`${path(id)}/brainstorms${page(offset)}`, { signal }),
  brainstorm: (id: string, brainstormId: string, signal?: AbortSignal) =>
    request<ConsiliumBrainstorm>(`${path(id)}/brainstorms/${brainstormId}`, { signal }),
  /** Запуск мозгового штурма по снимку досье — только явной кнопкой. */
  runBrainstorm: (id: string, payload: ConsiliumBrainstormCreate) =>
    request<ConsiliumBrainstorm>(`${path(id)}/brainstorms`, json('POST', payload)),
  /** Библиотека исследования (Т5, срез 0013): предложения, решения, исполнения. */
  proposals: (id: string, offset = 0, signal?: AbortSignal) =>
    request<ConsiliumProposalsPage>(`${path(id)}/proposals${page(offset)}`, { signal }),
  proposal: (id: string, proposalId: string, signal?: AbortSignal) =>
    request<ConsiliumProposal>(`${path(id)}/proposals/${proposalId}`, { signal }),
  addProposal: (id: string, payload: ConsiliumProposalCreate) =>
    request<ConsiliumProposal>(`${path(id)}/proposals`, json('POST', payload)),
  updateProposal: (id: string, proposalId: string, payload: ConsiliumProposalUpdate) =>
    request<ConsiliumProposal>(`${path(id)}/proposals/${proposalId}`, json('PATCH', payload)),
  /** Решение человека (принято/отклонено); append-only история не правится. */
  decideProposal: (id: string, proposalId: string, payload: ConsiliumDecisionCreate) =>
    request<ConsiliumDecision>(`${path(id)}/proposals/${proposalId}/decisions`, json('POST', payload)),
  /** Ручное исполнение предложения и результат; каждое — новой строкой. */
  executeProposal: (id: string, proposalId: string, payload: ConsiliumExecutionCreate) =>
    request<ConsiliumExecution>(
      `${path(id)}/proposals/${proposalId}/executions`, json('POST', payload),
    ),
  /** Боковая консультация (срез 0015): нити чата, реплики и повтор ответа. */
  chats: (id: string, signal?: AbortSignal) =>
    request<ConsiliumChatsPage>(`${path(id)}/chats`, { signal }),
  chatMessages: (id: string, chatId: string, signal?: AbortSignal) =>
    request<ConsiliumChatMessagesPage>(
      `${path(id)}/chats/${encodeURIComponent(chatId)}/messages?limit=200&offset=0`,
      { signal },
    ),
  /** Сообщение исследователя; ответ советника — задача очереди (202). */
  sendChatMessage: (id: string, payload: ConsiliumChatMessageCreate) =>
    request<ConsiliumChatSend>(`${path(id)}/chat-messages`, json('POST', payload)),
  /** Повтор неудавшегося ответа советника новой попыткой (append-only). */
  retryChatMessage: (id: string, messageId: string, payload: ConsiliumChatMessageRetry) =>
    request<ConsiliumChatMessage>(
      `${path(id)}/chat-messages/${encodeURIComponent(messageId)}/retry`,
      json('POST', payload),
    ),
}
