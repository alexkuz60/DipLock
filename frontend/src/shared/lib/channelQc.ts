/**
 * QC-индикаторы каналов вьюера (шаг 0.4): статус «ок/внимание/плохо» по доле
 * времени канала в зонах артефактов.
 *
 * Числа считает сервер (`channel_qc` в результате стадии `artifacts`: слитые
 * интервалы зон, без `ica_eog`), пороги приезжают с результатом
 * (`qc_warn_share`/`qc_bad_share` из `core/config.py`). Здесь — только чистые
 * функции порогов и текста тултипа, чтобы их можно было тестировать без DOM.
 *
 * Это зачатки QC-светофора: полный набор метрик (SNR, уровень 50 Гц,
 * `good_data_percent`) — этап 2.2 плана (`todo.md`), он расширит тот же
 * индикатор, не меняя контракта.
 */
import { ARTIFACT_LABELS, type ArtifactKind } from '@/shared/lib/artifacts'
import type { ChannelQc } from '@/shared/api/types'

export type ChannelQcStatus = 'ok' | 'warn' | 'bad'

/** Статус канала по доле времени в артефактах и порогам из конфига сервера. */
export function channelQcStatus(
  share: number,
  warnShare: number,
  badShare: number,
): ChannelQcStatus {
  if (share >= badShare) return 'bad'
  if (share >= warnShare) return 'warn'
  return 'ok'
}

/** Человекочитаемая причина статуса: доля и разбивка секунд по типам. */
export function channelQcTooltip(name: string, qc: ChannelQc): string {
  const percent = Math.round(qc.artifact_share * 100)
  if (qc.artifact_sec <= 0) {
    return `${name}: артефактов не найдено`
  }
  const parts = (Object.entries(qc.by_kind) as [ArtifactKind, number][])
    .filter(([, seconds]) => seconds > 0)
    .map(([kind, seconds]) => `${ARTIFACT_LABELS[kind]} ${seconds.toFixed(1)} с`)
  const breakdown = parts.length ? ` (${parts.join(', ')})` : ''
  return `${name}: артефакты ${percent}% времени${breakdown}`
}
