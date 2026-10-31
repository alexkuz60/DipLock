/** Адреса гипотез «N из M» (Т4/Т5); ошибки и транспорт — общие с приложением. */
import { API_PREFIX, request } from './client'
import type { HypothesisDraft, HypothesisRow, HypothesisSave, ProbeContext } from './types'

/** Профиль пробы → черновик правила (кандидаты условий, без вердикта). */
export async function draftRule(
  payload: HypothesisDraft,
  signal?: AbortSignal,
): Promise<HypothesisSave> {
  return request<HypothesisSave>(`${API_PREFIX}/hypotheses/draft-rule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
}

/** Контекст проб: признаки выборки в одной полосе (до проверки правила). */
export async function probeContext(
  recordingIds: string[],
  bandKey: string,
  signal?: AbortSignal,
): Promise<ProbeContext> {
  return request<ProbeContext>(`${API_PREFIX}/hypotheses/probe-context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recording_ids: recordingIds, band_key: bandKey }),
    signal,
  })
}

/** Сохранить правило в библиотеку (append, без проверки). */
export async function saveHypothesis(
  payload: HypothesisSave,
  signal?: AbortSignal,
): Promise<HypothesisRow> {
  return request<HypothesisRow>(`${API_PREFIX}/hypotheses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
}

/** Библиотека правил: новые сверху. */
export async function listHypotheses(signal?: AbortSignal): Promise<HypothesisRow[]> {
  return request<HypothesisRow[]>(`${API_PREFIX}/hypotheses`, { signal })
}
