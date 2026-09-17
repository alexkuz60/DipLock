/**
 * Мультитрековый вьюер ЭЭГ на uPlot (canvas).
 *
 * Один чарт на канал (дешёвый пересчёт при панорамировании), общая ось
 * времени у нижнего трека, огибающая min/max как band — пики артефактов
 * видны на любом уровне зума (см. `viewerMath.frameEnvelope`).
 *
 * Данные приходят кадром `SignalFrame`: огибающая уровня пирамиды от сервера
 * (срез 2.5, `GET /recordings/{id}/signals?level=`) или демо-фикстура. Вьюеру
 * не важно, откуда кадр: он не хранит сырые отсчёты и не декодирует EDF.
 *
 * Интеракции: колесо — дискретный зум ×1…×16 (якорь в точке курсора),
 * drag — панорамирование, клик — поставить курсор (время под точкой клика,
 * курсор живёт до следующего клика), клик по названию канала — открыть этот
 * канал в разделе «ЭЭГ» (срез 5), стрелка под названием — развернуть трек на
 * всю высоту области (повторный клик — свернуть). Каналы включаются и
 * выключаются только чекбоксами панели «Каналы».
 *
 * Поверх треков — **слои результата** (срез 2.6, `viewerLayers.ts` + `TrackLayers.tsx`):
 * зоны артефактов (клик → детали: тип, интервал, каналы), границы эпох с номерами и
 * штриховка отброшенных эпох. Слои — DOM поверх canvas, поэтому зум пересчитывает
 * только их позиции. До первого расчёта слои — демо-фикстура, после кнопок стадий
 * (`EdfRecalcButtons`, срез 2.7) — результат задачи.
 *
 * Экспорт окна (срез 2.8, `ExportActions` + `shared/lib/exportWindow.ts`): PNG-снапшот
 * склеивается из canvas'ов треков вместе с подписями, зонами и сеткой эпох, CSV — из
 * того же кадра, что виден в окне. Экспорт клиентский: сервер не пересчитывает экран.
 *
 * Чартам отключены собственные жесты (pointer-events: none): окном управляет
 * обёртка, чтобы drag/колесо работали одинаково на всех треках.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  anchoredCenter,
  clampCenter,
  panByPixels,
  xToTime,
  zoomWindow,
} from '@/shared/lib/viewerMath'
import type { SignalFrame } from '@/shared/lib/signalFrame'
import { LABEL_WIDTH, TRACK_HEIGHT } from '@/shared/lib/trackOptions'
import {
  artifactCounts,
  buildEpochCells,
  cellAtTime,
  demoLayers,
  gridEpochLength,
  visibleZones,
  type EdfViewerLayers,
} from '@/shared/lib/viewerLayers'
import { TIME_LEVELS, useEdfParams, useEdfParamsValue } from '@/shared/state/edfParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { useEegParams } from '@/shared/state/eegParams'
import { StatusPill } from '@/shared/ui/StatusPill'
import {
  ArtifactZoneLayer,
  EpochLayer,
  LayersLegend,
  SelectedZoneCard,
} from './TrackLayers'
import { ExportActions } from './ExportActions'
import { TrackRow } from './TrackRow'

export type TrackStackProps = {
  signal: SignalFrame
  /**
   * Слои результата (зоны артефактов, отброшенные эпохи). Приходят из стора
   * записи: до первого расчёта — демо-фикстура (`source: 'demo'`), после кнопок
   * стадий — результат задачи (`source: 'result'`, срез 2.7). Без пропа вьюер
   * рисует фикстуру — так он остаётся самостоятельным для отладки.
   */
  layers?: EdfViewerLayers
}

/** Стек треков с общей осью времени: зум ×1…×16, панорамирование, курсор. */
export function TrackStack({ signal, layers: layersProp }: TrackStackProps) {
  const params = useEdfParamsValue()
  const navigate = useNavigate()
  const toggleArtifactVisibility = useEdfParams((state) => state.toggleArtifactVisibility)
  /** Ручные пометки эпох живут при записи: они относятся к конкретной сессии */
  const epochMarks = useEdfRecording((state) => state.epochMarks)
  const toggleEpochBlock = useEdfRecording((state) => state.toggleEpochBlock)

  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  /** Высота видимой области треков — по ней разворачивается трек (срез 2.9) */
  const [viewportHeight, setViewportHeight] = useState(0)
  const [centerSec, setCenterSec] = useState(() => signal.durationSec / 2)
  const [cursor, setCursor] = useState<{ xPx: number; timeSec: number } | null>(null)
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null)
  /**
   * Развёрнутый трек (срез 2.9) — локальное состояние вьюера: клик по стрелке у
   * названия канала занимает всю высоту области, соседи остаются доступными
   * скроллом. Изменение — только отрисовка, расчёт от него не устаревает.
   */
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null)
  /**
   * Было ли смещение при drag-панорамировании: после перетаскивания клик не
   * должен ставить курсор (иначе курсор прыгал бы в конце каждого сдвига).
   */
  const draggedRef = useRef(false)
  /**
   * Canvas'ы треков (срез 2.8): uPlot рисует сигнал только в canvas, поэтому
   * PNG-снапшот склеивается из них. Держим в ref, а не в состоянии: регистрация
   * холста не должна перерисовывать вьюер, а актуальность обеспечивается тем,
   * что читаем мы её в момент нажатия кнопки экспорта.
   */
  const canvasesRef = useRef<Record<string, HTMLCanvasElement | null>>({})
  const registerCanvas = useCallback((name: string, canvas: HTMLCanvasElement | null) => {
    canvasesRef.current[name] = canvas
  }, [])

  // Слои результата: пока стадии не подключены — детерминированная фикстура.
  // Ключ — источник сигнала (запись/демо) и каналы, а не объект кадра: при зуме
  // сервер отдаёт новый кадр того же сигнала, и зоны не должны пересобираться.
  const channelKey = signal.channels.join(',')
  const layers = useMemo(
    () => layersProp ?? demoLayers(signal.durationSec, signal.channels),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layersProp, signal.sourceId, signal.durationSec, channelKey],
  )
  const visibleZoneList = useMemo(
    () => visibleZones(layers.artifacts, params.artifactVisibility),
    [layers.artifacts, params.artifactVisibility],
  )
  const counts = useMemo(() => artifactCounts(layers.artifacts), [layers.artifacts])
  /**
   * Длина эпохи сетки вьюера (срез 2.10): у слоя-результата — своя, у фикстуры —
   * параметр панели. Индексы отброшенных эпох живут только внутри своей нарезки,
   * поэтому смена длины эпохи в панели больше не «переезжает» штриховкой на
   * другой участок записи — она помечает слой как устаревший (пилюля в полосе).
   */
  const epochLengthMs = useMemo(
    () => gridEpochLength(layers, params.epochLengthMs),
    [layers, params.epochLengthMs],
  )
  const epochs = useMemo(
    () => buildEpochCells(signal.durationSec, epochLengthMs, layers.rejectedEpochs, epochMarks),
    [signal.durationSec, epochLengthMs, layers.rejectedEpochs, epochMarks],
  )
  /**
   * Сколько ручных пометок поставил пользователь (Ctrl+двойной клик).
   *
   * Считаем **правки**, а не ячейки сетки (срез 2.11): пометка — интервал на
   * таймлайне, поэтому после смены длины эпохи одна правка накрывает несколько
   * эпох новой нарезки, а их штриховки сливаются в одну видимую пометку. Счёт по
   * ячейкам показывал «ручных пометок: 6» там, где пользователь поставил три, и
   * расходился с панелью «Эпохи» (там тот же `epochMarks.length`).
   */
  const manualMarkCount = epochMarks.length
  /** Есть ли правки, видимые в текущей сетке: от этого зависит рендер слоёв */
  const hasManualEdit = useMemo(() => epochs.some((cell) => cell.manual !== null), [epochs])
  /** Сетка результата не совпадает с длиной эпохи в панели — разметка не пересчитана */
  const staleEpochGrid =
    layers.source === 'result' &&
    layers.epochLengthMs !== null &&
    layers.epochLengthMs !== params.epochLengthMs
  const selectedZone = useMemo(
    () => visibleZoneList.find((zone) => zone.id === selectedZoneId) ?? null,
    [visibleZoneList, selectedZoneId],
  )
  const hasLayers =
    visibleZoneList.length > 0 ||
    (params.epochBoundaries && epochs.length > 1) ||
    params.droppedEpochsHatched ||
    // Ручная пометка эпохи — решение пользователя: она видна всегда, даже если
    // штриховку и границы он выключил
    hasManualEdit

  // Новая запись/демо — возвращаемся к «вся сессия». Зависимость именно от
  // источника, а не от объекта кадра: при зуме сервер отдаёт новый кадр того же
  // сигнала, и сброс окна по нему ломал бы якорь зума и панорамирование.
  useEffect(() => {
    setCenterSec(signal.durationSec / 2)
    setCursor(null)
  }, [signal.sourceId, signal.durationSec])

  // Размер области треков: ширина окна (без колонки подписей) и высота,
  // по которой разворачивается трек (срез 2.9)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      setWidth(Math.max(0, (rect?.width ?? 0) - LABEL_WIDTH - 8))
      setViewportHeight(Math.max(0, rect?.height ?? 0))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Канал скрыли в панели «Каналы» — развёрнутый трек тоже сворачиваем
  useEffect(() => {
    if (expandedChannel && !params.visibleChannels.includes(expandedChannel)) {
      setExpandedChannel(null)
    }
  }, [expandedChannel, params.visibleChannels])

  const factor = TIME_LEVELS[params.timeLevel] ?? 1
  const window = zoomWindow(signal.durationSec, factor, centerSec)

  /*
    Навигация из тулс-хедера (`<<` `<` `>` `>>`, срез 2.9): кнопки живут в шапке,
    поэтому команда приходит через стор (`navRequest`) с монотонным `seq` —
    реагируем только на новую команду, а не на каждую перерисовку.
  */
  const navRequest = useEdfRecording((state) => state.navRequest)
  /**
   * Последняя обработанная команда. Инициализируется текущим `seq`: если вьюер
   * смонтировался уже после команды (переключение раздела и обратно), прокручивать
   * окно к старой цели не нужно — прыжок был бы неожиданным.
   */
  const handledNavSeqRef = useRef<number | null>(navRequest?.seq ?? null)
  useEffect(() => {
    if (!navRequest) return
    const { command, seq } = navRequest
    if (seq === handledNavSeqRef.current) return
    handledNavSeqRef.current = seq
    const level = useEdfParams.getState().params.timeLevel
    const widthSec = signal.durationSec / (TIME_LEVELS[level] ?? 1)
    setCursor(null)
    setCenterSec((current) => {
      const target =
        command === 'start'
          ? widthSec / 2
          : command === 'end'
            ? signal.durationSec - widthSec / 2
            : command === 'prev'
              ? current - widthSec
              : current + widthSec
      return clampCenter(target, widthSec, signal.durationSec)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navRequest?.seq])

  // Колесо = дискретный зум (нативный слушатель: React вешает wheel как passive,
  // а нам нужен preventDefault, чтобы колесо не скроллило область)
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const state = useEdfParams.getState()
      const level = state.params.timeLevel
      const next = Math.min(
        Math.max(level + (event.deltaY < 0 ? 1 : -1), 0),
        TIME_LEVELS.length - 1,
      )
      if (next === level) return

      const rect = el.getBoundingClientRect()
      const trackWidth = Math.max(1, rect.width - LABEL_WIDTH - 8)
      const xPx = Math.min(Math.max(event.clientX - rect.left - LABEL_WIDTH - 4, 0), trackWidth)
      const oldWin = zoomWindow(signal.durationSec, TIME_LEVELS[level], centerSec)
      const fraction = xPx / trackWidth
      // Якорь зума — время под курсором (та же функция, что у слоёв и курсора)
      const cursorSec = xToTime(xPx, oldWin, trackWidth)

      const newWidth = signal.durationSec / TIME_LEVELS[next]
      setCenterSec(anchoredCenter(cursorSec, fraction, newWidth, signal.durationSec))
      state.setParams({ timeLevel: next })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [signal, centerSec])

  // Drag = панорамирование
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    // Захват указателя берём **только когда жест стал панорамой**, а не на
    // `pointerdown`: с захватом браузер отдаёт `click` общему предку
    // pointerdown/pointerup, то есть контейнеру, и кнопка под названием канала
    // (переход в «ЭЭГ») или стрелка разворота теряла свой обработчик. На экране это
    // читалось как «переход по названию канала не работает»; в jsdom
    // `setPointerCapture` нет, поэтому тесты молчали.
    let pending = false
    let dragging = false
    let lastX = 0

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      // Кнопка в области треков — не начало панорамирования: у неё своё действие
      if ((event.target as HTMLElement | null)?.closest('button')) return
      pending = true
      dragging = false
      draggedRef.current = false
      lastX = event.clientX
    }
    const onPointerMove = (event: PointerEvent) => {
      if (!pending) return
      const dx = event.clientX - lastX
      if (!dragging) {
        // До порога это ещё клик: сдвиг курсора мышью не должен двигать окно
        if (Math.abs(dx) <= 3) return
        dragging = true
        draggedRef.current = true
        el.setPointerCapture?.(event.pointerId)
        el.style.cursor = 'grabbing'
      }
      lastX = event.clientX
      const state = useEdfParams.getState()
      const win = zoomWindow(
        signal.durationSec,
        TIME_LEVELS[state.params.timeLevel],
        centerSec,
      )
      const trackWidth = Math.max(1, el.clientWidth - LABEL_WIDTH - 8)
      setCenterSec(panByPixels(centerSec, dx, win, trackWidth, signal.durationSec))
    }
    const onPointerUp = (event: PointerEvent) => {
      pending = false
      dragging = false
      el.style.cursor = ''
      if (el.hasPointerCapture?.(event.pointerId)) el.releasePointerCapture(event.pointerId)
    }
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerUp)
    el.addEventListener('pointercancel', onPointerUp)
    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerUp)
      el.removeEventListener('pointercancel', onPointerUp)
    }
  }, [signal, centerSec])

  /**
   * Клик по названию канала (срез 5): канал открывается в разделе «ЭЭГ» — там он
   * уже выбран. Обработку клик не запускает: спектрограмма стартует только по
   * кнопке в шапке раздела «ЭЭГ».
   */
  function handleLabelClick(name: string) {
    useEegParams.getState().setChannel(name)
    navigate('/eeg')
  }

  /** Клик по стрелке у названия: развернуть трек на всю высоту / свернуть */
  function handleToggleExpand(name: string) {
    setExpandedChannel((current) => (current === name ? null : name))
  }

  /**
   * Клик по области треков ставит курсор в точку клика (срез 2.9): линия больше
   * не гоняется за мышью, а живёт на месте до следующего клика. Клики по кнопкам
   * (подписи каналов, зоны артефактов) и клики после перетаскивания игнорируются.
   */
  function handleTrackClick(event: MouseEvent<HTMLDivElement>) {
    const el = wrapRef.current
    if (!el || draggedRef.current) return
    if ((event.target as HTMLElement).closest('button')) return
    const rect = el.getBoundingClientRect()
    const xPx = event.clientX - rect.left - LABEL_WIDTH - 4
    const trackWidth = rect.width - LABEL_WIDTH - 8
    if (trackWidth <= 0 || xPx < 0 || xPx > trackWidth) return
    setCursor({ xPx: xPx + LABEL_WIDTH + 4, timeSec: xToTime(xPx, window, trackWidth) })
  }

  /**
   * Ctrl+двойной клик по треку (срез 2.10): инверсия блокировки эпохи, в
   * таймлайн которой попадает точка клика. Так пользователь правит и решение
   * reject-фильтра (снимает штриховку), и своё собственное (ставит её заново).
   * Пометка — интервал на таймлайне, поэтому смена длины эпохи её не сдвигает.
   */
  function handleTrackDoubleClick(event: MouseEvent<HTMLDivElement>) {
    if (!event.ctrlKey) return
    const el = wrapRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const trackWidth = rect.width - LABEL_WIDTH - 8
    const xPx = event.clientX - rect.left - LABEL_WIDTH - 4
    if (trackWidth <= 0 || xPx < 0 || xPx > trackWidth) return
    const cell = cellAtTime(epochs, xToTime(xPx, window, trackWidth))
    if (!cell) return
    toggleEpochBlock(
      { onsetSec: cell.onsetSec, durationSec: cell.durationSec },
      cell.rejected,
    )
  }

  /** Высота трека: развёрнутый занимает видимую область, обычный — TRACK_HEIGHT. */
  function trackHeight(name: string): number {
    if (name !== expandedChannel) return TRACK_HEIGHT
    // viewportHeight = 0 в средах без раскладки (jsdom) — оставляем обычную высоту
    return viewportHeight > 0 ? Math.max(TRACK_HEIGHT, viewportHeight - 8) : TRACK_HEIGHT
  }

  // Зоны/эпохи живут в пикселях области треков — та же геометрия, что у курсора
  const geometry = { window, trackWidth: width }
  const handleZoneSelect = useCallback((id: string | null) => setSelectedZoneId(id), [])

  // Порядок отображения — порядок каналов сигнала (монтаж), а не порядок кликов
  const visible = signal.channels.filter(
    (name) => params.visibleChannels.includes(name) && signal.max[name],
  )

  const pointsPerChannel = signal.times.length

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="track-stack">
      <div className="tnum flex items-center gap-3 px-2 py-1 text-xs text-fg-2">
        <span>
          Окно {window.t0.toFixed(2)}–{window.t1.toFixed(2)} с
        </span>
        <span>×{factor}</span>
        <span data-testid="signal-source">
          {signal.level > 0 ? `огибающая, ${pointsPerChannel} т/канал` : 'полный сигнал'}
        </span>
        {hasLayers ? (
          <StatusPill
            tone="neutral"
            title={
              layers.source === 'demo'
                ? 'Слои из демо-фикстуры (срез 2.6): результат появится после кнопок стадий в шапке раздела'
                : 'Слои из результата задачи предподготовки: зоны артефактов и отброшенные эпохи (срез 2.7)'
            }
          >
            слои: {layers.source === 'demo' ? 'демо-фикстура' : 'результат расчёта'}
          </StatusPill>
        ) : null}
        {staleEpochGrid ? (
          <StatusPill
            tone="warn"
            title={`Разметка эпох построена по нарезке результата — ${layers.epochLengthMs} мс; в панели выбрано ${params.epochLengthMs} мс. Нажмите «Нарезка эпох» в шапке, чтобы пересчитать и разложить эпохи заново.`}
          >
            разметка эпох: {layers.epochLengthMs} мс
          </StatusPill>
        ) : null}
        {manualMarkCount > 0 ? (
          <StatusPill
            tone="warn"
            title="Пометки пользователя: интервалы на таймлайне записи (Ctrl+двойной клик по треку переключает блокировку эпохи под курсором). Пометка живёт на таймлайне, поэтому после смены длины эпохи она накрывает несколько эпох новой нарезки — штриховок может быть больше, чем пометок. «Снять» — в панели «Эпохи»."
          >
            ручных пометок: {manualMarkCount}
          </StatusPill>
        ) : null}
        <ExportActions
          frame={signal}
          window={window}
          channels={visible}
          trackWidth={width}
          canvases={canvasesRef.current}
          zones={visibleZoneList}
          epochs={epochs}
          showEpochBoundaries={params.epochBoundaries}
          showDroppedEpochs={params.droppedEpochsHatched}
          amplitudeMode={params.amplitudeMode}
          amplitudeScaleUv={params.amplitudeScaleUv}
        />
        <span className="ml-auto truncate">
          Колесо — зум · drag — панорама · клик — курсор · клик по названию — канал в
          разделе «ЭЭГ» · стрелка у названия — развернуть трек · Ctrl+двойной клик — блокировка
          эпохи
        </span>
      </div>

      {hasLayers ? (
        <LayersLegend
          className="px-2 pb-1"
          counts={counts}
          visibility={params.artifactVisibility}
          onToggle={toggleArtifactVisibility}
        />
      ) : null}

      <div
        ref={wrapRef}
        role="region"
        aria-label="Треки ЭЭГ"
        className="scroll-y-always relative min-h-0 flex-1 cursor-crosshair overflow-x-hidden rounded-lg border border-border bg-bg-1 py-1 pr-2 select-none"
        onClick={handleTrackClick}
        onDoubleClick={handleTrackDoubleClick}
      >
        <div className="relative" data-testid="viewer-content">
          {visible.length === 0 ? (
            <p className="p-4 text-sm text-fg-2">
              Все каналы скрыты — включите их в панели «Каналы» справа.
            </p>
          ) : (
            visible.map((name, index) => (
              <TrackRow
                key={name}
                name={name}
                frame={signal}
                window={window}
                width={width}
                height={trackHeight(name)}
                expanded={name === expandedChannel}
                amplitudeMode={params.amplitudeMode}
                amplitudeScaleUv={params.amplitudeScaleUv}
                showXAxis={index === visible.length - 1}
                onLabelClick={handleLabelClick}
                onToggleExpand={handleToggleExpand}
                onCanvas={registerCanvas}
              />
            ))
          )}

          {/*
            Слои результата поверх canvas: одна система координат с курсором —
            колонка подписей (LABEL_WIDTH) плюс зазор и ширина области треков.
            Открывает список эпох, затем зоны артефактов: зоны кликабельны и
            должны быть выше штриховки/линий.
          */}
          {hasLayers ? (
            <div
              data-testid="track-layers"
              className="pointer-events-none absolute inset-y-0"
              style={{ left: LABEL_WIDTH + 4, width }}
            >
              <EpochLayer
                cells={epochs}
                geometry={geometry}
                showBoundaries={params.epochBoundaries}
                showHatch={params.droppedEpochsHatched}
              />
              <ArtifactZoneLayer
                zones={visibleZoneList}
                geometry={geometry}
                selectedId={selectedZoneId}
                onSelect={handleZoneSelect}
              />
            </div>
          ) : null}

          {/*
            Курсор — линия на всю высоту стека треков. Живёт внутри прокручиваемого
            контента (срез 2.11): раньше он был ребёнком самого скролл-контейнера,
            и при прокрутке вниз линия «уезжала» вверх и обрывалась на середине
            стека — выглядело как «позиционер не перерисовывается». Подпись
            времени — `sticky`: линия едет с треками, а время остаётся у верха
            видимой области и читается при любой прокрутке.
          */}
          {cursor ? (
            <>
              <div
                aria-hidden
                data-testid="cursor-line"
                className="pointer-events-none absolute inset-y-0 w-px bg-fg-2/70"
                style={{ left: cursor.xPx }}
              />
              <div className="pointer-events-none absolute inset-0">
                <div className="sticky top-1 h-0">
                  <div
                    data-testid="cursor-time"
                    className="tnum absolute rounded bg-bg-3 px-1.5 py-0.5 text-xs text-fg-0"
                    style={{ left: cursor.xPx + 6 }}
                  >
                    {cursor.timeSec.toFixed(3)} с
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {/*
            Панель выделенной зоны: тот же `sticky`, что у подписи курсора — детали
            зоны не уезжают за верх области, когда пользователь прокручивает треки.
          */}
          {selectedZone ? (
            <div className="pointer-events-none absolute inset-0">
              <div className="sticky top-1 flex justify-end pr-2">
                <SelectedZoneCard
                  zone={selectedZone}
                  onClose={() => setSelectedZoneId(null)}
                  className="pointer-events-auto z-10 max-w-xs"
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
