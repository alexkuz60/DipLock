/**
 * Анатомия кадра воспроизведения (срез 3.7): в какой структуре и в каком
 * поле Бродмана находится диполь на текущей эпохе кадра — и куда он «переходит».
 *
 * С 19.10.2026 описание живёт в секции «Локализация» панели «Опции» (перенос из
 * рабочей области): **отдельный абзац на каждую полосу** (или одиночный расчёт),
 * шрифт — как у текста панели (`text-sm`), крупная подпись над рядом проекций
 * (`text-lg`) убрана вместе с переносом. Тултип секции убран: он дублировал текст
 * абзацев (общая фраза об анатомии — в подсказке секции `DipolesPanel`, `hint`).
 *
 * Почему отдельный компонент, а не подпись в проекции: он подписан на **состояние**
 * (`playback.epochIndex`), а не на контекст кадра. Анатомия кадра — метка
 * измеренной точки своей эпохи, то есть величина, меняющаяся только на смене
 * эпохи (несколько раз в секунду), а не 60 раз. Подписка на номер эпохи даёт
 * синхронность с маркером кадра и не заставляет облако из сотен точек
 * перерисовываться на каждом кадре (правило среза 3.7).
 *
 * Точки берутся из того же слоя, что рисуют проекции (`dipoleLayerFromScan`), и
 * раскладываются по эпохам той же функцией, что у часов (`pointByEpoch`): строка
 * обязана описывать тот диполь, который видно маркером кадра, а не «похожий».
 * Запросов здесь нет: структуру и поле сервер посчитал ещё в результате.
 *
 * Честность состояний: пустой эпохе (отброшена нарезкой или у точки нет MNI) и
 * кадру, скрытому порогами отображения, метки соседних эпох не подставляются. Смена
 * анатомии показывается только в непрерывной цепочке эпох: через разрыв в данных
 * «перехода» нет (это разрыв, а не переход). Выключенный слой «Кадр
 * воспроизведения» убирает кадр с проекций — вместе с ним молчит и строка.
 */
import { useMemo } from 'react'
import {
  anatomyChangeText,
  anatomyText,
  frameAnchor,
  interpolatedPoint,
  nextAnatomyChange,
  nextMeasuredPoint,
} from '@/shared/lib/playback'
import { frameSources } from '@/shared/lib/dipoleBatch'
import {
  atlasLabels,
  pointPassesThresholds,
  type DisplayThresholds,
  thresholdsLabel,
} from '@/shared/lib/dipolePoints'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useDipoleParams } from '@/shared/state/dipoleParams'
import { StatusPill } from '@/shared/ui/StatusPill'

/**
 * Описание кадра одной полосы (или одиночного расчёта) — отдельный абзац секции.
 */
type BandAnatomySegment = {
  key: string
  /** Подпись полосы пакета (пусто — одиночный расчёт) */
  label: string
  text: string
  change: ReturnType<typeof nextAnatomyChange>
}

export function PlaybackAnatomyLine() {
  const result = useDipoleCalc((state) => state.result)
  const batch = useDipoleCalc((state) => state.batch)
  const playbackBandKeys = useDipoleCalc((state) => state.playbackBandKeys)
  const epochIndex = useDipoleCalc((state) => state.playback.epochIndex)
  const active = useDipoleCalc((state) => state.playback.active)
  const playing = useDipoleCalc((state) => state.playback.playing)
  const minGofPercent = useDipoleCalc((state) => state.gofThresholdPercent)
  const minAmplitudeNaM = useDipoleCalc((state) => state.amplitudeThresholdNam)
  /** Пороги отображения (GOF % и момент нА·м) — то же правило, что у кадра */
  const thresholds: DisplayThresholds = { minGofPercent, minAmplitudeNaM }
  /** Выключенный слой анимации убирает кадр с проекций — подписывать его нечего */
  const playbackLayerVisible = useDipoleParams((state) => state.params.layerVisibility.playback)

  /** Источники кадра — тот же сборщик и те же точки, что у часов кадра и облака */
  const sources = useMemo(() => frameSources(result, batch, playbackBandKeys), [result, batch, playbackBandKeys])

  // Кадр не задействован (нет слоя/результата/полос) — подписывать нечего
  if (sources.length === 0 || !active || !playbackLayerVisible) return null

  const epoch = epochIndex + 1
  /**
   * Кадры полос: метки — измеренной точке-якорю (кадр между эпохами
   * интерполирован, анатомия — нет); в эпохе без диполя честно подписывается
   * замедленный переход (сглаживание разрывов, 17.10.2026), а не «дыра».
   */
  const segments: BandAnatomySegment[] = sources.map(({ band, points }) => {
    const anchor = frameAnchor(points, epochIndex)
    const label = band?.label ?? ''
    const key = band?.key ?? 'single'
    if (!anchor) {
      return { key, label, text: 'диполя с MNI нет', change: null }
    }
    const frame = interpolatedPoint(points, epochIndex, 0)
    if (!frame || !pointPassesThresholds(frame, thresholds)) {
      return { key, label, text: `скрыт порогами «${thresholdsLabel(thresholds)}»`, change: null }
    }
    const gapEpochs = epochIndex - anchor.epochIndex
    let gapText = ''
    if (gapEpochs > 0) {
      // Эпохи без диполя от якоря до текущей (1-based): одиночная — «эпоха»,
      // диапазон — «эпохи». Дальше точки есть — переход замедлен; нет — кадр
      // держит последнюю измеренную точку (без «моргания», поправка 17.10.2026)
      const from = anchor.epochIndex + 2
      const noun = from === epoch ? 'эпоха' : 'эпохи'
      const range = from === epoch ? `${from}` : `${from}–${epoch}`
      gapText =
        nextMeasuredPoint(points, epochIndex) !== null
          ? ` (${noun} ${range} без диполя — переход замедлен)`
          : ` (удержание: ${noun} ${range} без диполя)`
    }
    return {
      key,
      label,
      text: anatomyText(atlasLabels(anchor)) + gapText,
      change: nextAnatomyChange(points, epochIndex),
    }
  })

  return (
    <div className="flex flex-col gap-1" data-testid="playback-anatomy">
      {/* Заголовок кадра — статус-пилюля: она же несёт признак воспроизведения
          (accent при игре), а описание — обычные абзацы панели ниже */}
      <StatusPill tone={playing ? 'accent' : 'neutral'}>{`Кадр: эпоха ${epoch}`}</StatusPill>
      {/* Описание локализации каждой полосы (или одиночного расчёта) — отдельным
          абзацем шрифтом панели «Опции» (`text-sm`); смена анатомии подписывается
          в абзаце своей полосы, а не общей строкой. Тултипов у абзацев нет: они
          дублировали этот же текст (19.10.2026). */}
      {segments.map((segment) => (
        <p key={segment.key} className="text-sm text-fg-1">
          {segment.label ? `${segment.label}: ${segment.text}` : segment.text}
          {segment.change ? ` · ${anatomyChangeText(segment.change)}` : ''}
        </p>
      ))}
    </div>
  )
}
