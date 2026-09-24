/**
 * QC-индикаторы каналов вьюера (шаг 0.4, расширен шагом 2.2): статус
 * «ок/внимание/плохо» по доле времени канала в зонах артефактов, SNR и признаку
 * мёртвого канала.
 *
 * Числа считает сервер (`channel_qc` в результате стадии `artifacts`: слитые
 * интервалы зон, без `ica_eog`, плюс `snr_db`/`dead`), пороги приезжают с
 * результатом (`qc_warn_share`/`qc_bad_share`/`qc_snr_*` из `core/config.py`).
 * Здесь — только чистые функции порогов и текста тултипа, чтобы их можно было
 * тестировать без DOM.
 *
 * Светофор записи (вердикт по всей записи) считает сервер (`record_status`) —
 * этот модуль только про по-канальные иконки.
 */
import { ARTIFACT_LABELS, type ArtifactKind } from '@/shared/lib/artifacts'
import type { ChannelQc } from '@/shared/api/types'

export type ChannelQcStatus = 'ok' | 'warn' | 'bad'

/**
 * Статус канала: худший из «доля времени в зонах», SNR (пороги из конфига
 * сервера) и мёртвый канал (константный до референса — всегда «плохо»).
 */
export function channelQcStatus(
  share: number,
  warnShare: number,
  badShare: number,
  snrDb: number | null = null,
  dead = false,
  snrWarnDb = 10,
  snrBadDb = 5,
): ChannelQcStatus {
  let status: ChannelQcStatus = 'ok'
  if (share >= badShare) status = 'bad'
  else if (share >= warnShare) status = 'warn'
  // Мёртвый электрод (шаг 2.2): сигнал дорисован средним — «плохо» однозначно
  if (dead) return 'bad'
  if (snrDb !== null) {
    if (snrDb < snrBadDb) return 'bad'
    if (snrDb < snrWarnDb && status !== 'bad') status = 'warn'
  }
  return status
}

/** Человекочитаемая причина статуса: доля, разбивка по типам, SNR, мёртвый. */
export function channelQcTooltip(name: string, qc: ChannelQc): string {
  const percent = Math.round(qc.artifact_share * 100)
  const extras: string[] = []
  if (qc.dead) extras.push('мёртвый канал (константный до референса)')
  if (qc.snr_db !== null) extras.push(`SNR ${qc.snr_db} дБ`)
  const extraText = extras.length ? ` · ${extras.join(' · ')}` : ''
  if (qc.artifact_sec <= 0) {
    return `${name}: артефактов не найдено${extraText}`
  }
  const parts = (Object.entries(qc.by_kind) as [ArtifactKind, number][])
    .filter(([, seconds]) => seconds > 0)
    .map(([kind, seconds]) => `${ARTIFACT_LABELS[kind]} ${seconds.toFixed(1)} с`)
  const breakdown = parts.length ? ` (${parts.join(', ')})` : ''
  return `${name}: артефакты ${percent}% времени${breakdown}${extraText}`
}
