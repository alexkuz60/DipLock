/**
 * Строка анатомии кадра воспроизведения (срез 3.7): в какой структуре и в каком
 * поле Бродмана находится диполь на текущей эпохе кадра — и куда он «переходит».
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
 * кадру, скрытому порогом «КД», метки соседних эпох не подставляются. Смена
 * анатомии показывается только в непрерывной цепочке эпох: через разрыв в данных
 * «перехода» нет (это разрыв, а не переход). Выключенный слой «Кадр
 * воспроизведения» убирает кадр с проекций — вместе с ним молчит и строка.
 */
import { useMemo } from 'react'
import {
  anatomyChangeText,
  anatomyText,
  nextAnatomyChange,
  pointByEpoch,
} from '@/shared/lib/playback'
import { atlasLabels, dipoleLayerFromScan } from '@/shared/lib/dipolePoints'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useDipoleParams } from '@/shared/state/dipoleParams'
import { StatusPill } from '@/shared/ui/StatusPill'

export function PlaybackAnatomyLine() {
  const result = useDipoleCalc((state) => state.result)
  const epochIndex = useDipoleCalc((state) => state.playback.epochIndex)
  const active = useDipoleCalc((state) => state.playback.active)
  const playing = useDipoleCalc((state) => state.playback.playing)
  const threshold = useDipoleCalc((state) => state.amplitudeThresholdNam)
  /** Выключенный слой анимации убирает кадр с проекций — подписывать его нечего */
  const playbackLayerVisible = useDipoleParams((state) => state.params.layerVisibility.playback)

  /** Точки по эпохам — тот же источник и та же раскладка, что у часов кадра */
  const pointsByEpoch = useMemo(
    () => (result ? pointByEpoch(dipoleLayerFromScan(result).points) : null),
    [result],
  )

  // Нет результата или кадр не задействован (нет слоя/кадра) — подписывать нечего
  if (!result || !pointsByEpoch || !active || !playbackLayerVisible) return null

  const epoch = epochIndex + 1
  const point = pointsByEpoch.get(epochIndex) ?? null
  /** Порог «КД» — правило отображения: скрытому кадру метки не подставляем */
  const hidden = point !== null && point.amplitudeNaM < threshold

  if (!point) {
    return (
      <StatusPill
        tone="warn"
        title="Эпоха отброшена нарезкой (reject) или у её точки нет MNI (fsaverage недоступен): анатомии в результате нет, и подставлять чужую нельзя."
      >
        {`Кадр: эпоха ${epoch} — диполя с MNI нет`}
      </StatusPill>
    )
  }

  if (hidden) {
    return (
      <StatusPill
        tone="warn"
        title={`Кадр слабее порога «КД ≥ ${threshold} нАм»: он не рисуется на проекциях, поэтому и анатомия не подписывается — иначе подпись расходилась бы с картинкой.`}
      >
        {`Кадр: эпоха ${epoch} — скрыт порогом «КД ≥ ${threshold} нАм»`}
      </StatusPill>
    )
  }

  const change = nextAnatomyChange(pointsByEpoch, epochIndex)
  const hint = [
    `Анатомия — метки измеренной точки эпохи ${epoch}: кадр между эпохами интерполирован, анатомия — нет.`,
    change
      ? anatomyChangeText(change)
      : 'Смены анатомии впереди не показано: впереди разрыв в данных или метки не меняются.',
  ].join('\n')

  return (
    <StatusPill tone={playing ? 'accent' : 'neutral'} title={hint}>
      {`Кадр: эпоха ${epoch} — ${anatomyText(atlasLabels(point))}`}
      {change ? ` · ${anatomyChangeText(change)}` : ''}
    </StatusPill>
  )
}
