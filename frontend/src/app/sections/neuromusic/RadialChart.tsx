/**
 * Радиальный график секции «Визуализация» «Нейромузыки»
 * (спецификация владельца 07.10.2026): оси X и Y через центр, 7 сегментов
 * (сегмент 1 — от π/2 + π/7, дальше против часовой), круги радиальной
 * сетки 25/50/75 % и круг-граница (рамка): лучи и оси ограничены его
 * диаметром — ничего не выходит за круг.
 *
 * **Терминология (общая, 07.10.2026):** сегмент (равная доля круга) ·
 * луч (радиал от центра к кругу-границе) · круг-граница (внешний диаметр) ·
 * вершина/«звезда» (точка на луче) · полигон (7 вершин по порядку лучей) ·
 * доминанта (белая линия из центра к точке суммы компонент вершин).
 *
 * **Анимация «Эмо» (08.10.2026):** с пропом `emo` (кадры
 * `GET /audio/render/{id}/emo`) лучи анимируются по позиции плеера —
 * `rAF` читает `getActivePlayer().position`, берёт интерполяцию между
 * слайдами (`emoRadar.interpolatedRays`) и пишет атрибуты polygon/доминанты
 * **императивно через refs** — без ре-рендеров React на каждый кадр
 * (`docs/rules/frontend-perf.md`). Сетка слайдов — шаг окна FFT 32000
 * сэмплов (2/3 с). Без данных/с ошибкой — прежний фоллбэк: случайные лучи
 * 0.1…1.0 R один раз на монтирование (без «прыжков» при ре-рендерах).
 * Полигон: заливка жёлтым с прозрачностью 0.25, грани — сплошные линии 2 px;
 * доминанта — белая линия и точка **8 px**. Статика поверх (08.10.2026):
 * **облако доминант** всех кадров (кружки **⌀8 px** — тот же диаметр, что у
 * текущей доминанты (правка 09.10.2026), без заливки,
 * обводка 1 px, позади полигона) и **суммарная доминанта** облака —
 * ярко-красный кружок ⌀8 px с заливкой 50 %, без линии вектора
 * (`totalDominant`: центроид облака — сумма компонент / число точек,
 * всегда **внутри** облака, в отличие от сырой суммы на ободе). Пиксельные
 * толщины —
 * `vector-effect="non-scaling-stroke"`. Геометрия — чистые модули
 * `radialChart.ts`, `emoRadar.ts`, `keyRotation.ts` и `tempoCorrection.ts`
 * (темп-коррекция 09.10.2026: радиусы вершин удлиняются на `Kr` своей
 * половине круга **после** вращения и **до** доминант, метка темпа —
 * засечка на оси Y); отрисовка SVG, как у соседнего
 * силуэта `BrainRoomView`.
 *
 * **Пропы «ЕмоЛаб» (21.10.2026)** — прежний вид «Нейромузыки» остаётся
 * дефолтом, раздел включает их явно: `bandColors` — дуги секторов 1…7
 * (`data-part="sector-arc"`) и залитые круги вершин полигона ⌀10 px
 * (`data-part="vertex-dot"`) в **гамме базовых полос «Диполей»**
 * (`shared/lib/bandColors.ts`: δ красный … γ-high розово-фиолетовый),
 * `dbRangeDb` — динамический диапазон шкалы лучей (окно `[−N … 0]` дБ,
 * `emoRadar.raysDbRange`), `tempoRays` — выкл/вкл значений темпа при
 * расчёте лучей звезды (метка темпа при этом продолжает показывать bpm).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AudioEmo } from '@/shared/api/types'
import { getActivePlayer } from '@/shared/state/neuromusicPlayer'
import { hopSeconds, interpolatedRays, framesDbRange } from './emoRadar'
import { frameRotations, interpolatedRotation } from './keyRotation'
import {
  frameTempos,
  interpolatedTempo,
  tempoY,
} from './tempoCorrection'
import {
  GRID_FRACTIONS,
  SECTOR_COLORS,
  SEGMENT_STEP,
  dominantCloud,
  dominantPoint,
  pointAt,
  randomRayPercents,
  segmentBoundaries,
  tempoStarPolygon,
  totalDominant,
} from './radialChart'

/** Размер viewBox: квадрат 200×200, центр — посередине. */
const VIEW = 200
const CENTER = VIEW / 2
/** Радиус графика (круг-граница), единиц viewBox: оси и лучи до него. */
const RADIUS = 90
/** Центр графика — константа модуля (стабильна для `useMemo`). */
const CENTER_PT = { x: CENTER, y: CENTER }
/**
 * Полный экранный диаметр текущей доминанты (точка на радиус-векторе), px —
 * нулевой штрих со скруглением `strokeWidth = DOMINANT_DOT_PX` +
 * `vector-effect="non-scaling-stroke"` (8 px на любом масштабе ячейки).
 * Кружки облака доминант держат **тот же** диаметр (правка 09.10.2026).
 */
const DOMINANT_DOT_PX = 8
/** Обводка кружков облака доминант, px (внутри — без заливки). */
const CLOUD_RING_STROKE_PX = 1
/**
 * Диаметр залитого круга в центре вершины полигона-звезды, px (правка
 * владельца 21.10.2026, поправка — **10 px**): нулевой штрих со скруглением
 * `strokeWidth = VERTEX_DOT_PX` + `vector-effect="non-scaling-stroke"` —
 * тот же приём, что у точки доминанты (`DOMINANT_DOT_PX`).
 */
const VERTEX_DOT_PX = 10

export type RadialChartProps = {
  /** Кадры «Эмо» (null/undefined — фоллбэк-рандомизатор до загрузки). */
  emo?: AudioEmo | null
  /**
   * Динамический диапазон шкалы лучей, дБ: окно `[−dbRangeDb … 0]` дБ →
   * `[0 … 100]` % R (`emoRadar.raysDbRange`, параметр «Опции раздела»
   * «ЕмоЛаб»). Не задан/≤ 0 — шкала контракта (`db_floor`, −60 дБ).
   */
  dbRangeDb?: number
  /**
   * Значения темпа участвуют в расчёте лучей звезды (темп-коррекция радиусов
   * `tempoStarPolygon`); `false` — радиусы без коррекции, метка темпа на оси Y
   * при этом продолжает показывать bpm кадра (чекбокс «ЕмоЛаб»). Дефолт —
   * поведение «Нейромузыки» (включено).
   */
  tempoRays?: boolean
  /**
   * Гамма полос: цветные дуги секторов 1…7 и залитые круги вершин полигона
   * ⌀10 px (правка владельца 21.10.2026, поправка — 10 px). Дефолт — выключено: «Нейромузыка»
   * рисует прежний нейтральный радар, включает «ЕмоЛаб».
   */
  bandColors?: boolean
}

export function RadialChart({
  emo = null,
  dbRangeDb = 0,
  tempoRays = true,
  bandColors = false,
}: RadialChartProps) {
  const boundaries = segmentBoundaries()
  // Фоллбэк-лучи: случайные 0.1…1.0 R — один раз на монтирование.
  const randomRays = useMemo(() => randomRayPercents(), [])
  // Кадры обязаны быть массивом: защита от ответа не по контракту (заглушка
  // мока, дрейф API) — иначе фоллбэк вместо падения.
  const frames = emo && Array.isArray(emo.frames) ? emo.frames : null
  // Динамический диапазон: лучи кадров переносятся из шкалы контракта
  // (`db_floor`) в окно [−dbRangeDb … 0] дБ одним местом — полигоны, облако
  // и анимация ниже читают уже перенесённые проценты. Шкала контракта либо
  // не заданный диапазон — кадры без изменений (та же ссылка, без копий).
  const scaledFrames = useMemo(
    () => (frames ? framesDbRange(frames, Number(emo?.db_floor), dbRangeDb) : null),
    [frames, emo, dbRangeDb],
  )
  // Углы вращения кадров — из тональности микса (key_track; без трека —
  // нули, звезда без поворота). Статика: меняется только с кадрами.
  const rotations = useMemo(
    () => frameRotations(emo?.key_track ?? null, frames ?? []),
    [emo, frames],
  )
  // Темп кадров — из VAMP Tempo and Beat Tracker (tempo_track; без трека —
  // null, темп-коррекция нулевая). Статика: меняется только с кадрами.
  const tempos = useMemo(
    () =>
      frameTempos(
        emo?.tempo_track ?? null,
        frames ?? [],
        emo ? hopSeconds(emo.hop_samples, emo.fs_audio) : 0,
      ),
    [emo, frames],
  )
  // Текущие лучи — в ref: rAF пишет их в DOM напрямую (без state), а JSX
  // при ре-рендере читает то же значение — рассинхрона «атрибут ↔ props» нет.
  const raysRef = useRef<number[]>(randomRays)
  const rotationRef = useRef(0)
  const tempoRef = useRef<number | null>(null)
  const lastFramesRef = useRef<typeof scaledFrames>(null)
  if (scaledFrames !== lastFramesRef.current) {
    lastFramesRef.current = scaledFrames
    const first = scaledFrames?.[0]
    raysRef.current = first ? [...first.rays] : randomRays
  }

  const polygonRef = useRef<SVGPolygonElement>(null)
  const dominantRef = useRef<SVGLineElement>(null)
  const dotRef = useRef<SVGLineElement>(null)
  const tempoMarkRef = useRef<SVGLineElement>(null)
  /** Залитые круги вершин полигона (гамма полос) — пишутся тем же paint. */
  const vertexDotsRef = useRef<(SVGLineElement | null)[]>([])

  /**
   * Масштаб ячейки: CSS-пикселей экрана на единицу viewBox (приём
   * `MriProjection`): кружки облака доминант держат экранный диаметр
   * `DOMINANT_DOT_PX` — в точности как точка текущей доминанты на
   * радиус-векторе (правка 09.10.2026), поэтому их радиус делится на
   * масштаб. SVG — квадрат с `preserveAspectRatio="meet"` → масштаб =
   * min(ширина, высота) / VIEW. В jsdom раскладки нет (rect = 0): масштаб
   * остаётся 1, и тесты видят «честные» пиксели.
   */
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [pxPerUnit, setPxPerUnit] = useState(1)
  useEffect(() => {
    const element = svgRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const rect = element.getBoundingClientRect()
      const side = Math.min(rect.width, rect.height)
      if (side > 0) setPxPerUnit(side / VIEW)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /** Один кадр → атрибуты полигона, доминанты и метки темпа (без React). */
  const paint = useCallback(
    (rays: readonly number[], rotationRad = 0, bpm: number | null = null) => {
      raysRef.current = [...rays]
      rotationRef.current = rotationRad
      tempoRef.current = bpm
      // Чекбокс темпа («ЕмоЛаб»): без значений темпа радиусы вершин не
      // корректируются, но метка темпа на оси Y показывает bpm кадра.
      const vertices = tempoStarPolygon(
        raysRef.current,
        RADIUS,
        CENTER_PT,
        rotationRad,
        tempoRays ? bpm : null,
      )
      const dominant = dominantPoint(vertices, CENTER_PT, RADIUS)
      polygonRef.current?.setAttribute(
        'points',
        vertices.map((vertex) => `${vertex.x},${vertex.y}`).join(' '),
      )
      // Залитые круги вершин (гамма полос) следуют за вершинами полигона.
      vertices.forEach((vertex, index) => {
        const dot = vertexDotsRef.current[index]
        if (!dot) return
        for (const attribute of ['x1', 'y1', 'x2', 'y2'] as const) {
          const value = attribute === 'x1' || attribute === 'x2' ? vertex.x : vertex.y
          dot.setAttribute(attribute, String(value))
        }
      })
      // Доминанта — из центра к точке суммы; точка — нулевой штрих в ней же.
      dominantRef.current?.setAttribute('x2', String(dominant.x))
      dominantRef.current?.setAttribute('y2', String(dominant.y))
      for (const attribute of ['x1', 'y1', 'x2', 'y2'] as const) {
        const value = attribute === 'x1' || attribute === 'x2' ? dominant.x : dominant.y
        dotRef.current?.setAttribute(attribute, String(value))
      }
      // Метка темпа на оси Y: y = tempoY(bpm) · R от центра (60 внизу,
      // 120 в центре, 240 вверху); темп не определён — засечка скрыта.
      const mark = tempoMarkRef.current
      if (mark) {
        if (bpm == null) {
          mark.setAttribute('opacity', '0')
        } else {
          const markY = CENTER - tempoY(bpm) * RADIUS
          mark.setAttribute('opacity', '1')
          mark.setAttribute('y1', String(markY))
          mark.setAttribute('y2', String(markY))
        }
      }
    },
    [tempoRays],
  )

  // Анимация: пока есть кадры, каждый кадр экрана читает позицию плеера
  // (с учётом rate ×0.5; вне игры — сохранённая позиция/0) и рисует
  // интерполированные лучи. Пауза/seek → сразу слайд текущей позиции.
  useEffect(() => {
    if (!emo || !scaledFrames) return
    const hopSec = hopSeconds(emo.hop_samples, emo.fs_audio)
    let raf = 0
    const tick = () => {
      const position = getActivePlayer()?.position ?? 0
      const rays = interpolatedRays(scaledFrames, hopSec, position)
      // Плавный доворот звезды: тот же линейный интерполятор, что у лучей.
      const rotation = interpolatedRotation(rotations, scaledFrames, hopSec, position) ?? 0
      // Темп кадра — тоже плавно, как лучи и вращение.
      const tempo = interpolatedTempo(tempos, scaledFrames, hopSec, position)
      if (rays) paint(rays, rotation, tempo)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [emo, scaledFrames, rotations, tempos, paint])

  const vertices = tempoStarPolygon(
    raysRef.current,
    RADIUS,
    CENTER_PT,
    rotationRef.current,
    tempoRays ? tempoRef.current : null,
  )
  const dominant = dominantPoint(vertices, CENTER_PT, RADIUS)
  const polygonPoints = vertices.map((vertex) => `${vertex.x},${vertex.y}`).join(' ')
  // Облако доминант всех кадров и их суммарная точка — статика (меняется
  // только при загрузке кадров): каждая точка = доминанта своего кадра
  // **после его вращения и темп-коррекции** (спецификация 09.10.2026),
  // суммарная = центроид облака (сумма компонент / число точек) — всегда
  // внутри облака, в отличие от сырой суммы, упиравшейся в обод.
  const cloud = useMemo(
    () =>
      scaledFrames
        ? dominantCloud(
            scaledFrames.map((frame, index) => ({
              rays: frame.rays,
              rotation: rotations[index] ?? 0,
              tempo: tempoRays ? (tempos[index] ?? null) : null,
            })),
            RADIUS,
            CENTER_PT,
          )
        : [],
    [scaledFrames, rotations, tempos, tempoRays],
  )
  const totalPoint = useMemo(
    () => (cloud.length > 0 ? totalDominant(cloud, CENTER_PT, RADIUS) : null),
    [cloud],
  )

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Радиальный график: круг-граница, оси X и Y, 7 сегментов, сетка 25/50/75 %, полигон и доминанта"
      data-testid="radial-chart"
      className="h-full w-full"
    >
      {/* Круг-граница: внешний диаметр, к нему приходят оси и лучи. */}
      <circle
        data-part="frame"
        cx={CENTER}
        cy={CENTER}
        r={RADIUS}
        fill="none"
        stroke="var(--color-border)"
        strokeWidth={2}
      />
      {/* Дуги секторов 1…7 в гамме базовых полос «Диполей» (bandColors):
          дуга сектора k идёт вдоль круга-границы от луча-разделителя k до
          k+1 (против часовой) и красится цветом полосы `BAND_ORDER[k]`
          (δ красный … γ-high розово-фиолетовый). */}
      {bandColors &&
        boundaries.map((angle, index) => {
          const start = pointAt(angle, RADIUS, CENTER_PT)
          const end = pointAt(angle + SEGMENT_STEP, RADIUS, CENTER_PT)
          return (
            <path
              key={index}
              data-part="sector-arc"
              d={`M ${start.x} ${start.y} A ${RADIUS} ${RADIUS} 0 0 0 ${end.x} ${end.y}`}
              fill="none"
              stroke={SECTOR_COLORS[index] ?? 'var(--color-border)'}
              strokeWidth={2}
            />
          )
        })}
      {/* Оси X (горизонталь) и Y (вертикаль) через центр, концы — на круге. */}
      <line
        data-part="axis"
        x1={CENTER - RADIUS}
        y1={CENTER}
        x2={CENTER + RADIUS}
        y2={CENTER}
        stroke="var(--color-fg-2)"
        strokeWidth={1}
      />
      <line
        data-part="axis"
        x1={CENTER}
        y1={CENTER - RADIUS}
        x2={CENTER}
        y2={CENTER + RADIUS}
        stroke="var(--color-fg-2)"
        strokeWidth={1}
      />
      {/* Лучи-разделители 7 сегментов (отсчёт — против часовой). */}
      {boundaries.map((angle, index) => {
        const end = pointAt(angle, RADIUS, CENTER_PT)
        return (
          <line
            key={index}
            data-part="ray"
            x1={CENTER}
            y1={CENTER}
            x2={end.x}
            y2={end.y}
            stroke="var(--color-border)"
            strokeWidth={1}
          />
        )
      })}
      {/* Круги радиальной сетки: 25 %, 50 %, 75 % радиуса. */}
      {GRID_FRACTIONS.map((fraction) => (
        <circle
          key={fraction}
          data-part="ring"
          cx={CENTER}
          cy={CENTER}
          r={RADIUS * fraction}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={1}
        />
      ))}
      {/* Облако доминант: точка доминанты каждого кадра анимации — кружки
          ⌀8 px без заливки, обводка 1 px (диаметр в точности как у текущей
          доминанты на радиус-векторе, правка 09.10.2026; позади полигона:
          история, полигон — «сейчас»). Считается один раз на загрузке кадров. */}
      {cloud.map((point, index) => (
        <circle
          key={index}
          data-part="dominant-cloud"
          cx={point.x}
          cy={point.y}
          r={(DOMINANT_DOT_PX - CLOUD_RING_STROKE_PX) / 2 / pxPerUnit}
          fill="none"
          stroke="var(--color-fg-2)"
          strokeWidth={CLOUD_RING_STROKE_PX}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {/* Полигон («звезда»): вершины из лучей (кадр «Эмо» или фоллбэк —
          случайные 0.1…1.0 R); заливка жёлтой с прозрачностью 0.25, грани —
          сплошные (не прозрачные) 2 px. Анимация пишет points через ref. */}
      <polygon
        ref={polygonRef}
        data-part="polygon"
        points={polygonPoints}
        fill="yellow"
        fillOpacity={0.25}
        stroke="yellow"
        strokeOpacity={1}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
      {/* Залитые круги в центрах вершин полигона-звезды ⌀10 px (bandColors) —
          цветом своей полосы, как дуга своего сектора; анимация двигает их
          через ref тем же paint, что и полигон. */}
      {bandColors &&
        vertices.map((vertex, index) => (
          <line
            key={index}
            ref={(element) => {
              vertexDotsRef.current[index] = element
            }}
            data-part="vertex-dot"
            x1={vertex.x}
            y1={vertex.y}
            x2={vertex.x}
            y2={vertex.y}
            stroke={SECTOR_COLORS[index] ?? 'var(--color-fg-1)'}
            strokeWidth={VERTEX_DOT_PX}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      {/* Доминанта: белая линия из центра к точке суммы компонент вершин. */}
      <line
        ref={dominantRef}
        data-part="dominant"
        x1={CENTER}
        y1={CENTER}
        x2={dominant.x}
        y2={dominant.y}
        stroke="white"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
      {/* Точка доминанты DOMINANT_DOT_PX = 8 px (правка 08.10.2026): нулевой
          штрих со скруглением = круг диаметра strokeWidth; кружки облака
          держат тот же экранный диаметр (правка 09.10.2026). */}
      <line
        ref={dotRef}
        data-part="dominant-dot"
        x1={dominant.x}
        y1={dominant.y}
        x2={dominant.x}
        y2={dominant.y}
        stroke="white"
        strokeWidth={DOMINANT_DOT_PX}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {/* Суммарная доминанта облака: центроид всех точек доминант кадров
          (сумма компонент / число точек — всегда внутри облака): ярко-красный
          кружок ⌀8 px с заливкой 50 %, без линии вектора. */}
      {totalPoint && (
        <circle
          data-part="total-dominant"
          cx={totalPoint.x}
          cy={totalPoint.y}
          r={4}
          fill="red"
          fillOpacity={0.5}
          stroke="red"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* Метка темпа на оси Y («Темп-коррекция», 09.10.2026), верхний слой:
          горизонтальная засечка на высоте tempoY(bpm)·R (60 внизу, 120 в
          центре, 240 вверху); темп не определён — засечка скрыта (иначе она
          ложится на ось X и сливается с ней). Анимация пишет y1/y2 и opacity
          через ref. */}
      <line
        ref={tempoMarkRef}
        data-part="tempo-mark"
        x1={CENTER - 12}
        y1={CENTER}
        x2={CENTER + 12}
        y2={CENTER}
        stroke="var(--color-accent)"
        strokeWidth={2}
        strokeLinecap="round"
        opacity={0}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}