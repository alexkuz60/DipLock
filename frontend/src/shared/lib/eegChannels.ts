/**
 * Канал раздела «ЭЭГ»: электрод записи или виртуальный микс группы (срез 5+).
 *
 * Модуль — единственное место, где UI отвечает на три вопроса о канале:
 * что показать в списке, как подписать и **какие каналы записи за ним стоят**.
 * Правила группировки имён 10-20 живут на сервере (`services/channel_mix.py`) и
 * приходят в паспорте записи (`RecordingMeta.mixes`): дублировать разбор
 * «T7 — височный, нечётный — левый» на клиенте значит однажды разойтись с ним.
 *
 * Трек микса считается здесь: пирамида сигналов отдаёт огибающую min/max по
 * каждому каналу, а микс — среднее по группе. Усреднять огибающие законно:
 * среднее лежит между min и max каждого канала, поэтому усреднённая полоса
 * гарантированно содержит средний сигнал (это и рисует трек).
 *
 * Демо-режим миксов не имеет: паспорта записи нет, группы считать не из чего, а
 * выдумывать их на клиенте — ровно то расхождение, которого модуль избегает.
 */
import type { RecordingMeta } from '@/shared/api/types'
import type { SignalFrame } from './signalFrame'

/** Префикс идентификатора виртуального канала (совпадает с сервером) */
export const MIX_PREFIX = 'mix:'

/** Пункт списка каналов: значение для формы расчёта и русская подпись */
export type ChannelOption = {
  value: string
  label: string
}

/** Виртуальный ли канал (по префиксу; известность группы проверяет сервер) */
export function isMixChannel(channel: string): boolean {
  return channel.startsWith(MIX_PREFIX)
}

/** Микс записи по идентификатору канала; `null` — обычный канал или демо-режим */
export function mixOf(recording: RecordingMeta | null, channel: string): RecordingMeta['mixes'][number] | null {
  return recording?.mixes.find((mix) => mix.id === channel) ?? null
}

/** Подпись канала для трека и статусной строки: «Fp1» или «Микс: Лобные» */
export function channelLabel(recording: RecordingMeta | null, channel: string): string {
  const mix = mixOf(recording, channel)
  return mix ? `Микс: ${mix.label}` : channel
}

/**
 * Список вариантов канала: сначала электроды записи (порядок монтажа всегда
 * привычен), затем виртуальные миксы. Миксы не смешиваются с электродами —
 * «микс» в подписи говорит, что это среднее, а не один отвод.
 */
export function channelOptions(
  recording: RecordingMeta | null,
  demoChannels: readonly string[] = [],
): ChannelOption[] {
  const channels = recording?.channels ?? [...demoChannels]
  const options: ChannelOption[] = channels.map((name) => ({ value: name, label: name }))
  for (const mix of recording?.mixes ?? []) {
    options.push({ value: mix.id, label: `Микс: ${mix.label}` })
  }
  return options
}

/**
 * Действующий канал раздела: выбранный, если он есть в записи, иначе первый
 * доступный. Сохранённый в localStorage микс не должен «залипать» на другой
 * записи без таких электродов (сервер вернул бы ошибку задачи).
 */
export function resolveChannel(
  recording: RecordingMeta | null,
  demoChannels: readonly string[],
  saved: string | null,
): string {
  const options = channelOptions(recording, demoChannels)
  if (saved && options.some((option) => option.value === saved)) return saved
  return options[0]?.value ?? ''
}

/** Электроды записи, которые отображает канал: у микса — группа, у электрода — он сам */
export function channelSourceChannels(
  recording: RecordingMeta | null,
  channel: string,
): string[] {
  const mix = mixOf(recording, channel)
  if (mix) return [...mix.channels]
  return channel ? [channel] : []
}

/**
 * Кадр для трека выбранного канала.
 *
 * Обычный канал отдаётся как есть (кадр уже содержит его огибающую). Микс
 * получает **свою** полосу min/max — среднее по каналам группы под ключом id
 * микса: `EegTrackView` рисует ровно один канал и о виртуальных вариантах не
 * знает.
 */
export function channelFrame(
  frame: SignalFrame,
  channel: string,
  channels: readonly string[],
): SignalFrame {
  // Электрод: ключ уже есть в кадре — усреднять нечего
  if (channels.length === 1 && channels[0] === channel && frame.min[channel]) return frame

  const names = channels.filter((name) => frame.min[name] && frame.max[name])
  if (!names.length) return frame

  const n = frame.times.length
  const min = new Float32Array(n)
  const max = new Float32Array(n)
  for (const name of names) {
    const lows = frame.min[name] as Float32Array
    const highs = frame.max[name] as Float32Array
    for (let i = 0; i < n; i++) {
      min[i] += lows[i] ?? 0
      max[i] += highs[i] ?? 0
    }
  }
  for (let i = 0; i < n; i++) {
    min[i] /= names.length
    max[i] /= names.length
  }
  return {
    ...frame,
    min: { ...frame.min, [channel]: min },
    max: { ...frame.max, [channel]: max },
  }
}
