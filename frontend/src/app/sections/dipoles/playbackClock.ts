/**
 * Часы кадра воспроизведения и его контекст (срез 3.7) — без разметки.
 *
 * Отдельный файл по двум причинам: провайдер — компонент, а правило
 * `react-refresh/only-export-components` требует, чтобы файл с компонентом
 * вывозил **только** компоненты; и сами часы — чистая логика времени, которой
 * разметка не нужна.
 *
 * Разделение обязанностей:
 * - **состояние** (играет/пауза, скорость, эпоха, `seekSeq`) живёт в
 *   `shared/state/dipoleCalc.ts`: команда идёт из шапки, а исполняется здесь;
 * - **непрерывное время кадра** живёт в этих часах (локальное состояние, ~60 раз в
 *   секунду): в стор уходит только смена эпохи, иначе каждое обновление кадра
 *   перерисовывало бы облако из сотен точек во всех трёх проекциях;
 * - **интерполяция** — чистая математика (`shared/lib/playback.ts`), здесь только
 *   её применение к результату задачи.
 *
 * Кадр раздаётся через контекст (`usePlaybackFrame`), поэтому маркер кадра внутри
 * проекций обновляется сам, а статичные слои (срез, поля, облако точек) при этом
 * не перерисовываются: элементы проекций создаются разделом и передаются
 * провайдеру как `children`, то есть остаются теми же объектами между кадрами.
 *
 * Интерполяция — **отображение, а не измерение**: промежуточных положений в
 * результате задачи нет. Поэтому кадр интерполируется только между соседними
 * эпохами с точками, а на паузе и при шаге равен измеренной точке своей эпохи.
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import {
  clampEpochIndex,
  epochAtTime,
  epochFraction,
  interpolatedPoint,
  playbackDurationMs,
  pointByEpoch,
} from '@/shared/lib/playback'
import { dipoleLayerFromScan, type DipolePoint } from '@/shared/lib/dipolePoints'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'

/** Кадр воспроизведения: время, доля внутри эпохи и интерполированная точка. */
export type PlaybackFrame = {
  /** Время кадра от начала записи, мс */
  timeMs: number
  /** Доля внутри текущей эпохи, 0…1 (для интерполяции позиции и вектора) */
  fraction: number
  /** Точка кадра; `null` — кадр пуст (эпоха без диполя или слабее порога «КД») */
  point: DipolePoint | null
}

/** Общая «пустая» карта точек: постоянная ссылка не сбрасывает мемоизацию. */
const NO_POINTS: Map<number, DipolePoint> = new Map()

/** Контекст кадра: значение кладёт `PlaybackFrameProvider` (файл-компонент). */
export const PlaybackFrameContext = createContext<PlaybackFrame | null>(null)

/**
 * Кадр воспроизведения из контекста. Без провайдера — `null`: проекцию можно
 * отрисовать отдельно (тесты, предпросмотр), и тогда маркера кадра просто нет.
 */
export function usePlaybackFrame(): PlaybackFrame | null {
  return useContext(PlaybackFrameContext)
}

/**
 * Часы воспроизведения. Пока `playing`, время кадра растёт по `requestAnimationFrame`
 * (дельта считается по метке кадра, а не по `performance.now`: часы не «дрейфуют»
 * на пропущенных кадрах и корректно идут под подменённым таймером в тестах).
 *
 * Что останавливает воспроизведение: конец нарезки (кадр встаёт на последнюю эпоху),
 * пауза из шапки, уход из раздела (часы живут только в нём).
 */
export function usePlaybackClock(): PlaybackFrame {
  const result = useDipoleCalc((state) => state.result)
  const playing = useDipoleCalc((state) => state.playback.playing)
  const speed = useDipoleCalc((state) => state.playback.speed)
  const epochIndex = useDipoleCalc((state) => state.playback.epochIndex)
  const seekSeq = useDipoleCalc((state) => state.playback.seekSeq)
  const active = useDipoleCalc((state) => state.playback.active)
  const threshold = useDipoleCalc((state) => state.amplitudeThresholdNam)

  const epochLengthMs = result?.epoch_length_ms ?? 0
  const totalEpochs = result?.n_epochs_total ?? 0
  const durationMs = playbackDurationMs(epochLengthMs, totalEpochs)

  /** Непрерывное время кадра, мс: 60 обновлений в секунду, поэтому не в сторе */
  const [timeMs, setTimeMs] = useState(0)

  /**
   * Пауза, шаг и перевод переносят кадр на начало своей эпохи: остановились — и
   * видим **измеренную** точку, а не «полутон» между эпохами.
   */
  useEffect(() => {
    if (playing) return
    setTimeMs(epochIndex * epochLengthMs)
  }, [playing, epochIndex, seekSeq, epochLengthMs])

  useEffect(() => {
    if (!playing || durationMs <= 0) return
    let raf = 0
    let last: number | null = null
    // Отсчёт идёт от текущего кадра: команда «покадрово» перед этим уже вставлена
    // в состояние, и часы обязаны её увидеть (см. `seekSeq` в `dipoleCalc`)
    let current = useDipoleCalc.getState().playback.epochIndex * epochLengthMs
    setTimeMs(current)

    const tick = (now: number) => {
      if (last !== null) current += (now - last) * speed
      last = now
      const store = useDipoleCalc.getState()
      if (current >= durationMs) {
        // Конец записи: кадр остаётся на последней эпохе, воспроизведение — стоп
        const lastEpoch = clampEpochIndex(totalEpochs - 1, totalEpochs)
        setTimeMs(lastEpoch * epochLengthMs)
        store.setPlaybackEpoch(lastEpoch)
        store.pausePlayback()
        return
      }
      setTimeMs(current)
      store.setPlaybackEpoch(epochAtTime(current, epochLengthMs, totalEpochs))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, seekSeq, epochLengthMs, totalEpochs, durationMs])

  useEffect(
    () => () => {
      // Часы живут только в разделе: ушли — воспроизведение остановлено, иначе при
      // возвращении кадр «прыгнул» бы на время, которого не видели
      useDipoleCalc.getState().pausePlayback()
    },
    [],
  )

  /** Точки по эпохам — из тех же данных, что рисует облако проекций */
  const pointsByEpoch = useMemo(
    () => (result ? pointByEpoch(dipoleLayerFromScan(result).points) : NO_POINTS),
    [result],
  )
  const fraction = active ? epochFraction(timeMs, epochLengthMs) : 0
  const point = useMemo(() => {
    if (!active) return null
    const frame = interpolatedPoint(pointsByEpoch, epochIndex, fraction)
    // Порог «КД» — правило отображения для всех диполей, включая кадр: слабый кадр
    // не рисуется, но воспроизведение продолжается (эпоха видна в шапке)
    return frame && frame.amplitudeNaM >= threshold ? frame : null
  }, [active, pointsByEpoch, epochIndex, fraction, threshold])

  return { timeMs, fraction, point }
}
