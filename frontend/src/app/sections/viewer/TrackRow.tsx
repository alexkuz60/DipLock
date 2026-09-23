/**
 * Один трек вьюера ЭЭГ: uPlot-чарт канала с огибающей min/max.
 *
 * Вынесен из `TrackStack.tsx` (правило `docs/rules/frontend-state.md` п.6): стек
 * отвечает за окно, зум, панорамирование и слои, а строка — за свой чарт.
 * Расчёт огибающей и опции чарта — чистые функции (`shared/lib/viewerMath.ts`,
 * `shared/lib/trackOptions.ts`), здесь только жизненный цикл uPlot:
 *
 * * чарт создаётся при смене канала/размера/режима шкалы (окно и данные
 *   применяются отдельными эффектами — дешевле, чем пересоздание);
 * * canvas отдаётся наружу через `onCanvas` — из них собирается PNG-снапшот
 *   (срез 2.8), поэтому холст обязан быть тем же, что видит пользователь;
 * * подпись канала — кнопка перехода в раздел «ЭЭГ», стрелка под ней —
 *   разворот трека на фиксированную высоту ×8 (срез 2.9, решение 22.09.2026);
 * * клик по развёрнутому треку — линия уровня в мкВ (п. 3 среза: значение
 *   считает uPlot `posToVal`, подпись — `formatUvLevel`), а зоны артефактов
 *   рисуются на нём по-канально (п. 4, `zonesForChannel`).
 */
import { useEffect, useMemo, useRef, type MouseEvent } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { frameEnvelope, pointsBudget, type TimeWindow } from '@/shared/lib/viewerMath'
import type { SignalFrame } from '@/shared/lib/signalFrame'
import { perfCount } from '@/shared/lib/perf'
import { formatUvLevel } from '@/shared/lib/eegView'
import {
  LABEL_WIDTH,
  expandRangeWithZero,
  makeTrackOptions,
  yRangeFor,
} from '@/shared/lib/trackOptions'
import type { ArtifactZone, EpochCell } from '@/shared/lib/viewerLayers'
import type { ChannelQcStatus } from '@/shared/lib/channelQc'
import { cx } from '@/shared/ui/cx'
import { ArtifactZoneLayer, EpochFrameLayer } from './TrackLayers'

export type TrackRowProps = {
  name: string
  frame: SignalFrame
  window: TimeWindow
  width: number
  /** Высота трека: `TRACK_HEIGHT` или фикс `EXPANDED_TRACK_HEIGHT` (×8) у развёрнутого */
  height: number
  /** Трек развёрнут на фикс ×8 («холст» под будущие слои: артефакты, «до/после») */
  expanded: boolean
  amplitudeMode: 'shared' | 'per_channel'
  amplitudeScaleUv: number
  showXAxis: boolean
  /** QC-статус канала (шаг 0.4): точка слева от имени; null — стадии артефактов не было */
  qc: { status: ChannelQcStatus; tooltip: string } | null
  /** Клик по названию канала — открыть его в разделе «ЭЭГ» (срез 5) */
  onLabelClick: (name: string) => void
  /** Клик по стрелке у названия — развернуть/свернуть трек (срез 2.9) */
  onToggleExpand: (name: string) => void
  /** Отдаёт наружу canvas трека: из них собирается PNG-снапшот (срез 2.8) */
  onCanvas: (name: string, canvas: HTMLCanvasElement | null) => void
  /**
   * Зоны артефактов развёрнутого трека — только его канал (`zonesForChannel`,
   * п. 4 среза); у превью пусто: общий слой стека рисует их поверх всех треков.
   */
  zones?: ArtifactZone[]
  /** Выделенная зона (общее состояние со всем стеком) */
  selectedZoneId?: string | null
  /** Клик по полосе зоны на развёрнутом треке */
  onZoneSelect?: (id: string | null) => void
  /** Рамки эпох-отбросов этого канала (причины блокировки, `epochFramesForChannel`) */
  epochFrames?: EpochCell[]
  /** Линия уровня: yPx — CSS-пиксели от верха чарта, levelUv — уровень в мкВ */
  levelMark?: { yPx: number; levelUv: number } | null
  /** Клик по развёрнутому треку отдаёт уровень сигнала под курсором */
  onPickLevel?: (mark: { yPx: number; levelUv: number }) => void
  /** Тянули ли окно: клик после drag не ставит линию уровня (как и курсор) */
  wasDragged?: () => boolean
}

export function TrackRow({
  name,
  frame,
  window,
  width,
  height,
  expanded,
  amplitudeMode,
  amplitudeScaleUv,
  showXAxis,
  qc,
  onLabelClick,
  onToggleExpand,
  onCanvas,
  zones = [],
  selectedZoneId = null,
  onZoneSelect,
  epochFrames = [],
  levelMark = null,
  onPickLevel,
  wasDragged,
}: TrackRowProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<uPlot | null>(null)

  const env = useMemo(() => {
    // Счётчик пересчёта огибающей — замер P4 (`docs/rules/frontend-perf.md`):
    // он должен расти при смене окна, а не при каждом рендере стека
    perfCount('edf.envelope.recompute')
    return frameEnvelope(
      frame.times,
      frame.min[name] ?? [],
      frame.max[name] ?? [],
      window,
      pointsBudget(width),
      frame.decimated,
    )
  }, [frame, name, window, width])
  /**
   * Диапазон оси Y считается по видимой огибающей, а не оставляется uPlot:
   * в режиме «по каналу» шкала обязана ужиматься под амплитуду конкретного
   * канала (иначе слабые каналы выглядят прямой линией). Считается чистой
   * функцией `yRangeFor` — покрыто `trackOptions.test.ts`.
   */
  const yRange = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < env.min.length; i++) {
      if (env.min[i] < lo) lo = env.min[i]
      if (env.max[i] > hi) hi = env.max[i]
    }
    // Развёрнутый вид — холст под слои: шкала всегда авто по каналу (общая на ×8
    // «утопила» бы сигнал — решение владельца) и ноль всегда в кадре — линия
    // отсчёта видна даже при дрейфе базовой линии (п. 1/2 среза)
    const range = yRangeFor(expanded ? 'per_channel' : amplitudeMode, amplitudeScaleUv, lo, hi)
    return expanded ? expandRangeWithZero(range) : range
  }, [env, amplitudeMode, amplitudeScaleUv, expanded])

  /** Есть ли размер области: до первого замера `ResizeObserver` чарт не создаём */
  const sized = width > 0 && height > 0

  /*
    Создание чарта — только при смене канала и признака оси времени. Размер и
    шкала Y применяются **отдельными эффектами** (`setSize` / `setScale`), а не
    пересозданием: раньше ресайз окна и переключение режима шкалы собирали заново
    все 18+ чартов стека (`docs/rules/frontend-perf.md`, правило Р4).
    `sized` в зависимостях — потому что до замера области размер нулевой, и без
    этого признака чарт не появился бы вовсе (эффект больше не реагирует на
    `width`).
  */
  /**
   * Живой флаг нулевой линии (хук `drawClear` в `makeTrackOptions`): читается на
   * каждой перерисовке. Чарт при развороте **не пересоздаётся** (тест «разворот
   * трека не пересобирает чарт», P1/P4), поэтому флаг — реф, а не поле опций:
   * эффект синхронизации объявлен до эффекта `setSize`, и перерисовка уже видит
   * новое значение.
   */
  const showZeroRef = useRef(expanded)
  useEffect(() => {
    showZeroRef.current = expanded
  }, [expanded])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !sized) return
    perfCount('edf.chart.create')
    const chart = new uPlot(
      makeTrackOptions(width, height, window, yRange, showXAxis, showZeroRef),
      [[], [], []] as uPlot.AlignedData,
      host,
    )
    chartRef.current = chart
    // uPlot рисует сигнал в canvas — только его можно склеить в PNG-снапшот
    onCanvas(name, chart.ctx?.canvas ?? null)
    return () => {
      chart.destroy()
      chartRef.current = null
      onCanvas(name, null)
    }
    // Канал и ось времени — в зависимостях; размер/шкала/окно обновляются ниже
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, showXAxis, sized])

  useEffect(() => {
    if (!sized) return
    chartRef.current?.setSize({ width, height })
  }, [width, height, sized])

  useEffect(() => {
    chartRef.current?.setScale('y', { min: yRange[0], max: yRange[1] })
  }, [yRange])

  useEffect(() => {
    chartRef.current?.setData([env.times, env.min, env.max] as uPlot.AlignedData, false)
    chartRef.current?.setScale('x', { min: window.t0, max: window.t1 })
  }, [env, window])

  /**
   * Клик по развёрнутому треку — линия уровня (п. 3 среза). Уровень считает uPlot
   * (`posToVal` — ровно обратен `valToPos`, иначе линия уедет от клика); событие
   * всплывает дальше и ставит курсор времени в `TrackStack` — это не мешает.
   * Клики по кнопкам и клик после drag не ставят уровень — те же правила, что у
   * курсора.
   */
  function handleRowClick(event: MouseEvent<HTMLDivElement>) {
    if (!expanded || !onPickLevel || wasDragged?.()) return
    if ((event.target as HTMLElement).closest('button')) return
    const host = hostRef.current
    const chart = chartRef.current
    if (!host || !chart) return
    const yCss = event.clientY - host.getBoundingClientRect().top
    onPickLevel({ yPx: yCss, levelUv: chart.posToVal(yCss * uPlot.pxRatio, 'y', true) })
  }

  return (
    <div
      className="relative flex items-stretch gap-1"
      data-testid={`track-${name}`}
      style={{ height }}
      onClick={handleRowClick}
    >
      <div
        className="relative flex shrink-0 flex-col items-end justify-center"
        style={{ width: LABEL_WIDTH }}
      >
        {qc ? (
          <span
            data-testid={`track-qc-${name}`}
            data-status={qc.status}
            title={qc.tooltip}
            aria-label={`Качество канала ${name}: ${qc.tooltip}`}
            className={cx(
              'absolute top-1/2 left-0.5 size-2 -translate-y-1/2 rounded-full',
              qc.status === 'ok' && 'bg-ok',
              qc.status === 'warn' && 'bg-warn',
              qc.status === 'bad' && 'bg-danger',
            )}
          />
        ) : null}
        <button
          type="button"
          data-testid={`track-label-${name}`}
          aria-label={`Открыть канал ${name} в разделе «ЭЭГ»`}
          title={`Открыть канал ${name} в разделе «ЭЭГ»: трек и спектрограмма STFT`}
          onClick={() => onLabelClick(name)}
          className="tnum w-full cursor-pointer truncate rounded text-right font-mono text-xs text-fg-2 hover:text-fg-0"
        >
          {name}
        </button>
        <button
          type="button"
          data-testid={`track-expand-${name}`}
          data-expanded={expanded}
          aria-pressed={expanded}
          aria-label={expanded ? `Свернуть трек ${name}` : `Развернуть трек ${name}`}
          title={expanded ? 'Свернуть трек' : 'Развернуть трек на высоту ×8'}
          onClick={() => onToggleExpand(name)}
          className={cx(
            'cursor-pointer rounded p-0.5',
            expanded ? 'text-accent' : 'text-fg-2 hover:bg-bg-3 hover:text-fg-0',
          )}
        >
          {expanded ? (
            <ChevronUp className="size-3.5" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5" aria-hidden />
          )}
        </button>
      </div>
      <div
        ref={hostRef}
        data-testid={`track-plot-${name}`}
        className="pointer-events-none min-w-0 flex-1"
      />
      {/*
        Слои развёрнутого трека: зоны артефактов его канала (п. 4) и линия уровня
        (п. 3). Рисуются поверх canvas строки, кликов не перехватывают (кроме полос
        зон — они кнопки, `ArtifactZoneLayer`), координаты те же, что у чарта.
      */}
      {/*
        Рамки эпох-отбросов этого канала (причины блокировки): reject-фильтр ронял
        эпохи именно по нему. Дополняют штриховку `EpochLayer`, клики не берут.
      */}
      {epochFrames.length > 0 ? (
        <div
          className="pointer-events-none absolute top-0 bottom-0"
          style={{ left: LABEL_WIDTH + 4, width }}
        >
          <EpochFrameLayer cells={epochFrames} geometry={{ window, trackWidth: width }} />
        </div>
      ) : null}
      {expanded && zones.length > 0 && onZoneSelect ? (
        <div
          className="pointer-events-none absolute top-0 bottom-0"
          style={{ left: LABEL_WIDTH + 4, width }}
        >
          <ArtifactZoneLayer
            zones={zones}
            geometry={{ window, trackWidth: width }}
            selectedId={selectedZoneId}
            onSelect={onZoneSelect}
          />
        </div>
      ) : null}
      {expanded && levelMark ? (
        <>
          <div
            aria-hidden
            data-testid="level-line"
            className="pointer-events-none absolute right-0 h-px bg-fg-2/70"
            style={{ left: LABEL_WIDTH + 4, top: levelMark.yPx }}
          />
          <div
            data-testid="level-label"
            className="tnum pointer-events-none absolute right-0 rounded bg-bg-3 px-1.5 py-0.5 text-xs text-fg-0"
            style={{ top: levelMark.yPx, transform: 'translateY(-50%)' }}
          >
            {formatUvLevel(levelMark.levelUv)}
          </div>
        </>
      ) : null}
    </div>
  )
}
