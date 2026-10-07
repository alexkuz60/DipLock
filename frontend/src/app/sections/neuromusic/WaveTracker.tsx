/**
 * Трекер-плеер «Нейромузыки»: линейка времени + волна-бабочка (≤200 px) +
 * позиционер поверх сигнала; клик/перетаскивание — перемотка
 * (docs/rules/neuromusic.md, §«Плеер-трекер»).
 *
 * Под трекером в будущих шагах появятся ещё две горизонтальные области
 * визуализации — карточка занимает только свою полосу рабочей области.
 *
 * Здесь же жизненный цикл движка: `NeuromusicPlayer.load` по renderId,
 * синхронизация параметров «Пространства»/источника/скорости из сторов и
 * rAF-цикл (окно зума, позиционер, таймкод, конец трека). На кадре
 * перерисовывается только оверлей позиционера; волна и линейка — при смене
 * окна (правило `docs/rules/frontend-perf.md`).
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { api } from '@/shared/api/client'
import { NeuromusicPlayer } from '@/shared/lib/neuromusicPlayer'
import {
  drawButterfly,
  drawPlayhead,
  drawRuler,
  filePeaks,
  formatTime,
  peakColumns,
  prepareCanvas,
  rulerTicks,
  trackerTheme,
  viewWindow,
  xToTime,
  type ButterflyPeaks,
  type TrackerTheme,
  type ViewState,
} from '@/shared/lib/waveformView'
import { useNeuromusic } from '@/shared/state/neuromusic'
import { getActivePlayer, useNeuromusicPlayer } from '@/shared/state/neuromusicPlayer'

/** Высота волны-бабочки, px — потолок раздела (ТЗ: не более 200). */
const WAVE_HEIGHT_PX = 200
/** Высота линейки времени над волной, px. */
const RULER_HEIGHT_PX = 26
/** Минимальный интервал перемотки при перетаскивании, мс (иначе ×60 рестартов/с). */
const SEEK_THROTTLE_MS = 50

export type WaveTrackerProps = {
  /** id готового рендера — адреса WAV из `api.audio*Url` */
  renderId: string
  /** Ключи полос в порядке партитуры (`status.tracks`) */
  tracks: string[]
  /**
   * ref таймкода в хедере раздела (контролы слева от Play/Stop): `paint`
   * пишет в него textContent — позиция/длительность без ре-рендеров хедера.
   */
  timeRef: RefObject<HTMLSpanElement | null>
}

/** Текст ошибки движка для пользователя. */
function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Не удалось построить плеер'
}

export function WaveTracker({ renderId, tracks, timeRef }: WaveTrackerProps) {
  const source = useNeuromusicPlayer((state) => state.source)
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
  /** Пики текущего источника (пересчёт — при смене источника/зума/ширины). */
  const peaksRef = useRef<ButterflyPeaks | null>(null)
  /** Текущее окно зума (якорь позиционера). */
  const viewRef = useRef<ViewState | null>(null)
  /** Последняя отрисованная позиция — чтобы не трогать оверлей на кадр без изменений. */
  const lastRef = useRef({ pos: Number.NaN })
  const widthRef = useRef(0)
  widthRef.current = width
  const themeRef = useRef<TrackerTheme | null>(null)
  if (!themeRef.current) themeRef.current = trackerTheme()
  /**
   * Свой экземпляр движка: cleanup освобождает его даже если стор уже сброшен
   * сменой записи (сброс обнуляет глобальный ref без dispose).
   */
  const playerRef = useRef<NeuromusicPlayer | null>(null)
  /**
   * Применённое состояние 3D-режима: `load` строит граф с этим значением, и
   * эффект ниже не дёргает `setSpatial` с no-op при готовности движка.
   */
  const spatialAppliedRef = useRef<boolean | null>(null)
  /**
   * Новые пики без смены окна (смена источника/зума/ширины): волна обязана
   * перерисоваться — окно `viewWindow` при этом не изменилось.
   */
  const waveDirtyRef = useRef(true)
  /** Ручной старт окна слайдером (`null` — автослежение за позиционером). */
  const scrollRef = useRef<number | null>(null)
  /** Слайдер прокрутки — синхронизируется из paint без рендера (там же тултип). */
  const sliderRef = useRef<HTMLInputElement>(null)

  const trackKey = tracks.join(',')
  /** Параметры слайдера: 0…(длительность − окно), шаг = 1/100 окна. */
  const windowSpan = duration / zoom
  const sliderMax = Math.max(0, duration - windowSpan)
  const sliderStep = Math.max(windowSpan / 100, 1e-6)

  // Движок: один на renderId; параметры «Пространства» читаются на момент сборки.
  // Размонтирование (уход из раздела/смена записи) освобождает граф и буферы.
  useEffect(() => {
    let cancelled = false
    const playerStore = useNeuromusicPlayer.getState()
    const renderStore = useNeuromusic.getState()
    spatialAppliedRef.current = renderStore.spatialEnabled
    playerStore.beginLoad()
    NeuromusicPlayer.load({
      masterUrl: api.audioMasterUrl(renderId),
      tracks: tracks.map((key) => ({ key, url: api.audioTrackUrl(renderId, key) })),
      irUrl: api.audioIrUrl(renderStore.spatialIr),
      source: playerStore.source,
      rate: playerStore.rate,
      spatial: renderStore.spatialEnabled,
      widthPct: renderStore.spatialWidthPct,
      spreadPct: renderStore.spatialSpreadPct,
      wetPct: renderStore.spatialWetPct,
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
    // trackKey, а не tracks: массив из `status.tracks` стабилен, но ESLint
    // требует явной зависимости — строка не меняется при перерисовках.
  }, [renderId, tracks, trackKey])

  // Параметры «Пространства» применяются к живому графу мгновенно (правило
  // «правка ≠ расчёт»): включение режима перестраивает граф с сохранением
  // позиции, остальное — real-time сеттеры. Зависимость от ready ловит правку,
  // случившуюся пока движок ещё собирался.
  const spatialEnabled = useNeuromusic((state) => state.spatialEnabled)
  useEffect(() => {
    const player = getActivePlayer()
    if (!player || spatialAppliedRef.current === spatialEnabled) return
    spatialAppliedRef.current = spatialEnabled
    useNeuromusicPlayer.getState().beginLoad()
    void player.setSpatial(spatialEnabled).then(
      () => useNeuromusicPlayer.getState().endLoad(),
      (cause: unknown) => useNeuromusicPlayer.getState().fail(errorText(cause)),
    )
  }, [spatialEnabled, ready])

  const widthPct = useNeuromusic((state) => state.spatialWidthPct)
  useEffect(() => {
    getActivePlayer()?.setWidth(widthPct)
  }, [widthPct, ready])

  const spreadPct = useNeuromusic((state) => state.spatialSpreadPct)
  useEffect(() => {
    getActivePlayer()?.setSpread(spreadPct)
  }, [spreadPct, ready])

  const wetPct = useNeuromusic((state) => state.spatialWetPct)
  useEffect(() => {
    getActivePlayer()?.setWet(wetPct)
  }, [wetPct, ready])

  // Смена помещения — GET готового IR-ассета (не расчёт), подмена без остановки.
  const irPreset = useNeuromusic((state) => state.spatialIr)
  useEffect(() => {
    const player = getActivePlayer()
    if (!player) return
    void player.setIrUrl(api.audioIrUrl(irPreset)).catch((cause: unknown) => {
      useNeuromusicPlayer.setState({ error: errorText(cause) })
    })
  }, [irPreset, ready])

  /**
   * Отрисовка трекера. Стабильна (только ref'ы и сторы) — её зовут rAF и
   * эффекты. Волна/линейка перерисовываются при смене окна (зум, ресайз,
   * ручная прокрутка) и при новых пиках (dirty-флаг — смена источника без
   * смены окна); на кадре — позиционер, таймкод и полоса слайдера.
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
    // игре позиционер вышел за него — возврат к автослежению (иначе трек
    // «уехал» бы из-под позиционера).
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
      if (waveCtx) drawButterfly(waveCtx, peaksRef.current, view, duration, w, WAVE_HEIGHT_PX, theme)
    }
    const tenths = state.zoom >= 100
    // Большой палец слайдера едет вместе с окном; пока слайдер в фокусе —
    // значение пользователя не перетираем (его тянет pointer/клавиши).
    const slider = sliderRef.current
    if (slider) {
      if (document.activeElement !== slider) slider.value = String(view.start)
      // Подпись видимого отрезка живёт в тултипе слайдера (сам ряд во всю
      // ширину плеера, приёмка 07.10.2026). React пишет `title` только при
      // смене пропа — правку paint он не затирает.
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
    if (timeRef.current) {
      timeRef.current.textContent = `${formatTime(pos, tenths)} / ${formatTime(duration, tenths)}`
    }
    // timeRef — prop из хедера: объект стабилен (useRef родителя), зависимость
    // нужна только для ESLint exhaustive-deps.
  }, [timeRef])

  // Пики «бабочки» для текущего источника: пересчёт при смене источника, зума
  // или ширины; `null` пока буфер не загрузился (рисуется одна линия нуля).
  // Каждый пересчёт помечает волну «грязной» — paint дорисует её даже если
  // окно viewWindow не изменилось (иначе смена источника не видна).
  useEffect(() => {
    waveDirtyRef.current = true
    const buffer = getActivePlayer()?.bufferFor(source) ?? null
    if (!buffer || width <= 0) {
      peaksRef.current = null
      paint()
      return
    }
    const left = buffer.getChannelData(0)
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left
    peaksRef.current = filePeaks(left, right, peakColumns(width, zoom, left.length))
    paint()
  }, [source, zoom, width, ready, loading, paint])

  // Смена зума — новое окно «вокруг позиционера» (подсказка ×N): ручную
  // прокрутку сбрасываем, иначе окно осталось бы далеко от позиционера.
  useEffect(() => {
    scrollRef.current = null
  }, [zoom])

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
      data-testid="neuromusic-tracker"
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
