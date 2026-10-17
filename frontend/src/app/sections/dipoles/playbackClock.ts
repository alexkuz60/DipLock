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
  frameAnchor,
  interpolatedPoint,
  playbackDurationMs,
  trailSegments,
  type TrailSegment,
} from '@/shared/lib/playback'
import { frameSources } from '@/shared/lib/dipoleBatch'
import {
  pointPassesThresholds,
  type DisplayThresholds,
  type DipoleBandTag,
  type DipolePoint,
} from '@/shared/lib/dipolePoints'
import type { MniVector } from '@/shared/lib/mriProjections'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'

/**
 * Кадр одной полосы (С1): у пакета одновременно живут диполи всех отмеченных
 * полос, и каждая несёт свою точку, шлейф и тег (цвет/подпись). У одиночного
 * расчёта полосы нет (`band: null`) — один кадр прежнего вида.
 */
export type BandFrame = {
  /** Полоса пакета (`null` — одиночный расчёт: без полосного цвета) */
  band: DipoleBandTag | null
  /** Точка кадра; `null` — не рисуется (нет измерений или слабее порогов отображения) */
  point: DipolePoint | null
  /** Якорь: последняя измеренная точка не позже эпохи (ей принадлежат метки кадра) */
  anchor: DipolePoint | null
  /** Шлейф: завершённые измеренные переходы последних секунд, гаснущие с возрастом */
  trail: TrailSegment[]
  /**
   * Растущий сегмент текущего перехода (якорь → кадр), `null` — кадр стоит на
   * измеренной точке. Сглаживание разрывов (17.10.2026): пока кадр едет
   * замедленно к следующей точке, его «хвост» тянется за ним и не исчезает.
   */
  headSegment: { from: MniVector; to: MniVector } | null
}

/** Кадр воспроизведения: время, доля эпохи и кадры отмеченных полос. */
export type PlaybackFrame = {
  /** Время кадра от начала записи, мс */
  timeMs: number
  /** Доля внутри текущей эпохи, 0…1 (для интерполяции позиции и вектора) */
  fraction: number
  /** Кадры полос: от одного (одиночный расчёт) до всех полос пакета */
  frames: BandFrame[]
}

/** Общий «пустой» шлейф — постоянная ссылка не сбрасывает мемоизацию. */
const NO_TRAIL: TrailSegment[] = []

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
  const batch = useDipoleCalc((state) => state.batch)
  const playbackBandKeys = useDipoleCalc((state) => state.playbackBandKeys)
  const playing = useDipoleCalc((state) => state.playback.playing)
  const speed = useDipoleCalc((state) => state.playback.speed)
  const epochIndex = useDipoleCalc((state) => state.playback.epochIndex)
  const seekSeq = useDipoleCalc((state) => state.playback.seekSeq)
  const active = useDipoleCalc((state) => state.playback.active)
  const minGofPercent = useDipoleCalc((state) => state.gofThresholdPercent)
  const minAmplitudeNaM = useDipoleCalc((state) => state.amplitudeThresholdNam)
  /** Пороги отображения (GOF % и момент нА·м) — одно правило на кадр и шлейф */
  const thresholds: DisplayThresholds = useMemo(
    () => ({ minGofPercent, minAmplitudeNaM }),
    [minGofPercent, minAmplitudeNaM],
  )

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

  /**
   * Источники кадра — по чекбоксам полос пакета (`frameSources`): одни и те же
   * точки, что рисует облако проекций (включая теги полос).
   */
  const sources = useMemo(
    () => frameSources(result, batch, playbackBandKeys),
    [result, batch, playbackBandKeys],
  )
  const fraction = active ? epochFraction(timeMs, epochLengthMs) : 0
  /**
   * Кадры полос: точка + шлейф + растущий сегмент перехода. Пороги отображения —
   * правило для всех диполей, включая кадр: слабый кадр не рисуется, но
   * воспроизведение продолжается (эпоха видна в шапке), и шлейф при этом живёт.
   */
  const frames = useMemo<BandFrame[]>(
    () =>
      sources.map(({ band, points }) => {
        const anchor = frameAnchor(points, epochIndex)
        const raw = active ? interpolatedPoint(points, epochIndex, fraction) : null
        const point = raw && pointPassesThresholds(raw, thresholds) ? raw : null
        const trail = active
          ? trailSegments(points, epochIndex, epochLengthMs, thresholds)
          : NO_TRAIL
        // Сегмент текущего перехода: кадр оторвался от якоря (едет к следующей
        // измеренной точке) — его «хвост» тянется от якоря и не даёт траектории
        // «моргнуть» на эпохах без диполя
        const headSegment =
          point && anchor && pointsDiffer(point.position, anchor.position)
            ? { from: anchor.position, to: point.position }
            : null
        return { band, point, anchor, trail, headSegment }
      }),
    [sources, active, epochIndex, fraction, thresholds, epochLengthMs],
  )

  return { timeMs, fraction, frames }
}

/** Позиции различаются (кадр едет, а не стоит на измеренной точке). */
function pointsDiffer(a: MniVector, b: MniVector): boolean {
  return a.x !== b.x || a.y !== b.y || a.z !== b.z
}
