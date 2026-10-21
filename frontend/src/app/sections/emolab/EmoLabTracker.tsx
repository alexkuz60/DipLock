/**
 * Трекер-плеер «ЕмоЛаб» (шаг 1, 20.10.2026): линейка времени + волна-бабочка
 * (≤200 px) + позиционер; клик/перетаскивание — перемотка.
 *
 * Адаптация `neuromusic/WaveTracker.tsx` под внешний аудиотрек (постановка
 * 20.10.2026): аудио не синтезируется и не имеет полос-источников (только
 * «Микс»), пространственной пост-обработки нет, скорость воспроизведения
 * только ×1. Вместо адресов рендера движок получает `blob:` URL локального
 * файла (`useEmoLab.audioUrl`) — плеер играет без сервера.
 *
 * **Пирамида превью** волны: пики «бабочки» (`waveformView.filePeaks`)
 * кэшируются по уровням зума ×1/×10/×100 — уровень пересчитывается только
 * при смене ширины/буфера, а не на каждый зум (длинные треки не перескани-
 * руются целиком при каждом переключении).
 *
 * Поверх волны — аннотации Соник Аннотатора из кадров «Эмо»: вертикали смены
 * аккордов и ступенчатый график темпа (`waveformView.drawKeyLines` /
 * `drawTempoSteps`) — та же механика, что в «Нейромузыке», но ступени темпа
 * идут на **шкале темпа радара** (`neuromusic/tempoCorrection.radarTempoStepY`,
 * поправка 21.10.2026): 0 сигнала волны = 120 bpm, низ графика = 60 bpm,
 * верх = 240 bpm — линия над волной и метка темпа на радаре на одной шкале.
 * Там же — вертикали сегментов трека с метками имён A, B, C…
 * (`waveformView.drawSegmentLines`, VAMP Segmenter, «ЕмоЛаб»):
 * визуально-слуховой контроль анализа, в расчётах данные не участвуют.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AudioEmo } from '@/shared/api/types'
import { NeuromusicPlayer } from '@/shared/lib/neuromusicPlayer'
import {
  drawButterfly,
  drawKeyLines,
  drawPlayhead,
  drawRuler,
  drawSegmentLines,
  drawTempoSteps,
  filePeaks,
  formatTime,
  peakColumns,
  prepareCanvas,
  rulerTicks,
  trackerTheme,
  viewWindow,
  xToTime,
  type ButterflyPeaks,
  type TimeZoom,
  type TrackerTheme,
  type ViewState,
} from '@/shared/lib/waveformView'
import { useEmoLab } from '@/shared/state/emolab'
import { MASTER_SOURCE, getActivePlayer, useNeuromusicPlayer } from '@/shared/state/neuromusicPlayer'
import { radarTempoStepY } from '../neuromusic/tempoCorrection'
import { trackerTimeRef } from '../neuromusic/trackerTimeRef'

/** Высота волны-бабочки, px — потолок раздела (как в «Нейромузыке»: ≤200). */
const WAVE_HEIGHT_PX = 200
/** Высота линейки времени над волной, px. */
const RULER_HEIGHT_PX = 26
/** Минимальный интервал перемотки при перетаскивании, мс (иначе ×60 рестартов/с). */
const SEEK_THROTTLE_MS = 50

export type EmoLabTrackerProps = {
  /**
   * Кадры «Эмо» с картами Соник Аннотатора (`key_track`/`tempo_track`) —
   * аннотации на волне (null — аннотаций нет, волна без них).
   */
  emo?: AudioEmo | null
}

/** Текст ошибки движка для пользователя. */
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Не удалось построить плеер'
}

export function EmoLabTracker({ emo = null }: EmoLabTrackerProps) {
  const audioUrl = useEmoLab((state) => state.audioUrl)
  const zoom = useNeuromusicPlayer((state) => state.zoom)
  const ready = useNeuromusicPlayer((state) => state.ready)
  const loading = useNeuromusicPlayer((state) => state.loading)
  const error = useNeuromusicPlayer((state) => state.error)
  /** Для слайдера прокрутки: максимум зависит от длительности (state, не ref). */
  const duration = useNeuromusicPlayer((state) => state.duration)

  /** Ширина области трекера (ResizeObserver) — её же тикает «сырой» ref для rAF. */
  const [width, setWidth] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const rulerRef = useRef<HTMLCanvasElement>(null)
  const waveRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  /**
   * Пирамида превью: пики «бабочки» по уровням зума (ключ — ×1/×10/×100).
   * Ширина входит в колонки пиков — при её смене пирамида пересобирается.
   */
  const peaksRef = useRef(new Map<TimeZoom, ButterflyPeaks>())
  const peaksWidthRef = useRef(0)
  /** Текущее окно зума (якорь позиционера). */
  const viewRef = useRef<ViewState | null>(null)
  /** Последняя отрисованная позиция — чтобы не трогать оверлей на кадр без изменений. */
  const lastRef = useRef({ pos: Number.NaN })
  const widthRef = useRef(0)
  widthRef.current = width
  /** Аннотации Соник Аннотатора: `paint` читает их из ref (он стабилен). */
  const emoRef = useRef<AudioEmo | null>(emo)
  emoRef.current = emo
  const themeRef = useRef<TrackerTheme | null>(null)
  if (!themeRef.current) themeRef.current = trackerTheme()
  /** Свой экземпляр движка: cleanup освобождает его даже при сброшенном сторе. */
  const playerRef = useRef<NeuromusicPlayer | null>(null)
  /** Новые пики без смены окна: волна обязана перерисоваться. */
  const waveDirtyRef = useRef(true)
  /** Ручной старт окна слайдером (`null` — автослежение за позиционером). */
  const scrollRef = useRef<number | null>(null)
  /** Слайдер прокрутки — синхронизируется из paint без рендера (там же тултип). */
  const sliderRef = useRef<HTMLInputElement>(null)

  /** Параметры слайдера: 0…(длительность − окно), шаг = 1/100 окна. */
  const windowSpan = duration / zoom
  const sliderMax = Math.max(0, duration - windowSpan)
  const sliderStep = Math.max(windowSpan / 100, 1e-6)

  // Движок: один на открытый файл (`blob:` URL), простой граф без 3D —
  // `spatial: false` не грузит стемы и IR (ловушка NeuromusicPlayer.load).
  // Скорость фиксирована ×1 (постановка «ЕмоЛаб»).
  useEffect(() => {
    if (!audioUrl) return
    let cancelled = false
    const playerStore = useNeuromusicPlayer.getState()
    playerStore.beginLoad()
    NeuromusicPlayer.load({
      masterUrl: audioUrl,
      tracks: [],
      irUrl: '',
      source: MASTER_SOURCE,
      rate: 1,
      spatial: false,
      widthPct: 100,
      spreadPct: 100,
      wetPct: 0,
    })
      .then((player) => {
        if (cancelled) {
          player.dispose()
          return
        }
        playerRef.current = player
        useNeuromusicPlayer.getState().attach(player)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        useNeuromusicPlayer.getState().fail(errorText(cause))
      })
    return () => {
      cancelled = true
      playerRef.current?.dispose()
      playerRef.current = null
      useNeuromusicPlayer.getState().detach()
    }
  }, [audioUrl])

  /**
   * Отрисовка трекера. Стабильна (только ref'ы и сторы) — её зовут rAF и
   * эффекты. Волна/линейка перерисовываются при смене окна (зум, ресайз,
   * ручная прокрутка) и при новых пиках (dirty-флаг); на кадре — позиционер,
   * таймкод и полоса слайдера (правило `docs/rules/frontend-perf.md`).
   */
  const paint = useCallback(() => {
    const player = getActivePlayer()
    const state = useNeuromusicPlayer.getState()
    const theme = themeRef.current
    const w = widthRef.current
    if (!player || !state.ready || !theme || w <= 0) return
    const duration = state.duration
    const pos = Math.min(player.position, duration)
    const autoView = viewWindow(duration, state.zoom, pos, viewRef.current?.start ?? null)
    let view = autoView
    // Ручная прокрутка слайдером: окно держится, пока позиционер внутри; при
    // игре позиционер вышел за него — возврат к автослежению.
    if (scrollRef.current !== null) {
      const span = autoView.end - autoView.start
      const start = Math.min(Math.max(0, scrollRef.current), Math.max(0, duration - span))
      const manualView = { start, end: start + span }
      const moved = pos !== lastRef.current.pos
      if (moved && (pos < manualView.start || pos > manualView.end)) {
        scrollRef.current = null
      } else {
        view = manualView
      }
    }
    const viewChanged = viewRef.current?.start !== view.start || viewRef.current?.end !== view.end
    if (viewChanged) {
      viewRef.current = view
      const rulerCtx = rulerRef.current ? prepareCanvas(rulerRef.current, w, RULER_HEIGHT_PX) : null
      if (rulerCtx) {
        drawRuler(
          rulerCtx,
          rulerTicks(view, Math.max(4, Math.floor(w / 110))),
          view,
          w,
          RULER_HEIGHT_PX,
          theme,
        )
      }
    }
    if (viewChanged || waveDirtyRef.current) {
      waveDirtyRef.current = false
      const waveCtx = waveRef.current ? prepareCanvas(waveRef.current, w, WAVE_HEIGHT_PX) : null
      if (waveCtx) {
        drawButterfly(
          waveCtx,
          peaksRef.current.get(state.zoom) ?? null,
          view,
          duration,
          w,
          WAVE_HEIGHT_PX,
          theme,
        )
        // Аннотации Соник Аннотатора поверх волны (та же статика окна):
        // вертикали смены аккордов и ступенчатый график темпа.
        drawKeyLines(
          waveCtx,
          emoRef.current?.key_track ?? null,
          view,
          w,
          WAVE_HEIGHT_PX,
          theme,
        )
        drawTempoSteps(
          waveCtx,
          emoRef.current?.tempo_track ?? null,
          view,
          w,
          WAVE_HEIGHT_PX,
          theme,
          // Шкала темпа радара (поправка 21.10.2026): 0 волны = 120 bpm,
          // низ графика = 60, верх = 240 — высота линии совпадает с меткой
          // темпа на радаре при одном bpm.
          radarTempoStepY,
        )
        // Сегменты трека (VAMP Segmenter, «ЕмоЛаб»): вертикали с метками имён
        // A, B, C… — визуально-слуховой контроль, в расчётах не участвуют.
        drawSegmentLines(
          waveCtx,
          emoRef.current?.segment_track ?? null,
          view,
          w,
          WAVE_HEIGHT_PX,
          theme,
        )
      }
    }
    const tenths = state.zoom >= 100
    // Большой палец слайдера едет вместе с окном; пока слайдер в фокусе —
    // значение пользователя не перетираем.
    const slider = sliderRef.current
    if (slider) {
      if (document.activeElement !== slider) slider.value = String(view.start)
      const scrollable = state.duration - state.duration / Math.max(1, state.zoom) > 0
      const hint = scrollable
        ? 'Прокрутка окна вдоль записи: пока позиционер в окне — автослежение стоит, вышло за окно — возвращается'
        : 'Прокрутка появляется при зуме ×10/×100'
      const title = `${hint} · отрезок ${formatTime(view.start, tenths)} – ${formatTime(view.end, tenths)}`
      if (slider.title !== title) slider.title = title
    }
    if (!viewChanged && pos === lastRef.current.pos) return
    lastRef.current = { pos }
    const totalHeight = RULER_HEIGHT_PX + WAVE_HEIGHT_PX
    const overlayCtx = overlayRef.current ? prepareCanvas(overlayRef.current, w, totalHeight) : null
    if (overlayCtx) drawPlayhead(overlayCtx, pos, view, w, totalHeight, theme)
    if (trackerTimeRef.current) {
      trackerTimeRef.current.textContent = `${formatTime(pos, tenths)} / ${formatTime(duration, tenths)}`
    }
    // trackerTimeRef — общий модульный ref таймкода хедера (`EmoLabToolActions`):
    // пишет в него textContent — позиция/длительность без ре-рендеров хедера.
  }, [])

  // Пирамида превью: уровни зума пересобираются при смене буфера/ширины;
  // смена зума берёт готовый уровень (без повторного сканирования файла).
  useEffect(() => {
    waveDirtyRef.current = true
    const buffer = getActivePlayer()?.bufferFor(MASTER_SOURCE) ?? null
    if (!buffer || width <= 0) {
      peaksRef.current.clear()
      peaksWidthRef.current = 0
      paint()
      return
    }
    if (peaksWidthRef.current !== width) {
      peaksRef.current.clear()
      peaksWidthRef.current = width
    }
    if (!peaksRef.current.has(zoom)) {
      const left = buffer.getChannelData(0)
      const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left
      peaksRef.current.set(zoom, filePeaks(left, right, peakColumns(width, zoom, left.length)))
    }
    paint()
  }, [audioUrl, zoom, width, ready, loading, paint])

  // Смена зума — новое окно «вокруг позиционера» (подсказка ×N): ручную
  // прокрутку сбрасываем, иначе окно осталось бы далеко от позиционера.
  useEffect(() => {
    scrollRef.current = null
  }, [zoom])

  // Аннотации Соник Аннотатора приходят с кадрами «Эмо» уже после первого
  // рендера трекера — волна обязана перерисоваться с ними (dirty-флаг).
  useEffect(() => {
    waveDirtyRef.current = true
    paint()
  }, [emo, paint])

  // rAF-цикл: конец трека, окно зума с якорем позиционера, позиционер, таймкод.
  // Без единого setState — всё через ref'ы и canvas (frontend-perf).
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const state = useNeuromusicPlayer.getState()
      const player = getActivePlayer()
      if (player && state.ready && state.playing) {
        if (player.duration > 0 && player.position >= player.duration - 0.05) {
          player.finish()
          useNeuromusicPlayer.getState().setPlaying(false)
        }
      }
      paint()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [paint])

  // Ширина области трекера (в тестах ResizeObserver даёт заглушку 1024 px).
  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0)
      if (next > 0 && next !== widthRef.current) {
        // Ширина сменилась: bitmap-холсты подготовятся заново — окно считаем
        // заново (viewRef=null → viewChanged), иначе линейка осталась бы
        // растянутой картинкой прошлой ширины.
        viewRef.current = null
        setWidth(next)
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /** Перемотка по указателю: точка → время окна → seek (драг — с троттлингом). */
  const draggingRef = useRef(false)
  const lastSeekRef = useRef(0)
  const seekAt = useCallback((clientX: number, element: HTMLElement, exact: boolean) => {
    const state = useNeuromusicPlayer.getState()
    if (!state.ready) return
    // Окно берём из paint; если тот ещё не успел отрисовать — считаем заново.
    const view =
      viewRef.current ??
      viewWindow(state.duration, state.zoom, getActivePlayer()?.position ?? 0, null)
    const rect = element.getBoundingClientRect()
    const w = rect.width > 0 ? rect.width : widthRef.current
    if (w <= 0) return
    if (!exact && Date.now() - lastSeekRef.current < SEEK_THROTTLE_MS) return
    lastSeekRef.current = Date.now()
    const time = xToTime(clientX - rect.left, view, w)
    state.seek(Math.max(0, Math.min(state.duration, time)))
  }, [])

  return (
    <section
      aria-label="Трекер сигнала"
      data-testid="emolab-tracker"
      className="flex flex-col gap-3 rounded-xl border border-border bg-bg-2 p-4"
    >
      <div
        ref={wrapRef}
        data-testid="tracker-surface"
        className="relative cursor-crosshair touch-none select-none"
        style={{ height: RULER_HEIGHT_PX + WAVE_HEIGHT_PX }}
        onPointerDown={(event) => {
          draggingRef.current = true
          try {
            event.currentTarget.setPointerCapture(event.pointerId)
          } catch {
            /* jsdom без захвата указателя — обходится без него */
          }
          seekAt(event.clientX, event.currentTarget, true)
        }}
        onPointerMove={(event) => {
          if (draggingRef.current) seekAt(event.clientX, event.currentTarget, false)
        }}
        onPointerUp={(event) => {
          if (!draggingRef.current) return
          draggingRef.current = false
          try {
            event.currentTarget.releasePointerCapture(event.pointerId)
          } catch {
            /* указатель не был захвачен */
          }
          // Точная финальная точка — последний шаг драга мог быть троттлингом.
          seekAt(event.clientX, event.currentTarget, true)
        }}
        onPointerCancel={() => {
          draggingRef.current = false
        }}
      >
        <canvas
          ref={rulerRef}
          aria-hidden
          className="absolute left-0 top-0 w-full"
          style={{ height: RULER_HEIGHT_PX }}
        />
        <canvas
          ref={waveRef}
          aria-hidden
          className="absolute left-0 w-full"
          style={{ top: RULER_HEIGHT_PX, height: WAVE_HEIGHT_PX }}
        />
        <canvas
          ref={overlayRef}
          aria-hidden
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
      </div>

      {/* Прокрутка окна вдоль записи (при ×1 окно = файлу — выключен); подпись
          видимого отрезка — в тултипе (`paint` дописывает её туда же). */}
      <input
        ref={sliderRef}
        type="range"
        aria-label="Прокрутка окна по времени"
        title={
          sliderMax <= 0
            ? 'Прокрутка появляется при зуме ×10/×100'
            : 'Прокрутка окна вдоль записи: пока позиционер в окне — автослежение стоит, вышло за окно — возвращается'
        }
        min={0}
        max={sliderMax}
        step={sliderStep}
        disabled={sliderMax <= 0}
        className="h-1.5 w-full cursor-pointer accent-accent"
        onChange={(event) => {
          scrollRef.current = Number(event.target.value)
          paint()
        }}
      />

      {loading && (
        <p className="text-sm text-fg-2" data-testid="tracker-loading">
          Загрузка сигнала…
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          Плеер: {error}
        </p>
      )}
    </section>
  )
}