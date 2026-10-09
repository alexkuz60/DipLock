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
 * **облако доминант** всех кадров (мелкие круги ⌀5 px без заливки,
 * обводка 1 px, позади полигона) и **суммарная доминанта** облака —
 * ярко-красный кружок ⌀8 px с заливкой 50 %, без линии вектора
 * (`totalDominant`: центроид облака — сумма компонент / число точек,
 * всегда **внутри** облака, в отличие от сырой суммы на ободе). Пиксельные
 * толщины —
 * `vector-effect="non-scaling-stroke"`. Геометрия — чистые модули
 * `radialChart.ts` и `emoRadar.ts`; отрисовка SVG, как у соседнего
 * силуэта `BrainRoomView`.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { AudioEmo } from '@/shared/api/types'
import { getActivePlayer } from '@/shared/state/neuromusicPlayer'
import { hopSeconds, interpolatedRays } from './emoRadar'
import { frameRotations, interpolatedRotation } from './keyRotation'
import {
  GRID_FRACTIONS,
  dominantCloud,
  dominantPoint,
  pointAt,
  randomRayPercents,
  segmentBoundaries,
  starPolygon,
  totalDominant,
} from './radialChart'

/** Размер viewBox: квадрат 200×200, центр — посередине. */
const VIEW = 200
const CENTER = VIEW / 2
/** Радиус графика (круг-граница), единиц viewBox: оси и лучи до него. */
const RADIUS = 90
/** Центр графика — константа модуля (стабильна для `useMemo`). */
const CENTER_PT = { x: CENTER, y: CENTER }

export type RadialChartProps = {
  /** Кадры «Эмо» (null/undefined — фоллбэк-рандомизатор до загрузки). */
  emo?: AudioEmo | null
}

export function RadialChart({ emo = null }: RadialChartProps) {
  const boundaries = segmentBoundaries()
  // Фоллбэк-лучи: случайные 0.1…1.0 R — один раз на монтирование.
  const randomRays = useMemo(() => randomRayPercents(), [])
  // Кадры обязаны быть массивом: защита от ответа не по контракту (заглушка
  // мока, дрейф API) — иначе фоллбэк вместо падения.
  const frames = emo && Array.isArray(emo.frames) ? emo.frames : null
  // Углы вращения кадров — из тональности микса (key_track; без трека —
  // нули, звезда без поворота). Статика: меняется только с кадрами.
  const rotations = useMemo(
    () => frameRotations(emo?.key_track ?? null, frames ?? []),
    [emo, frames],
  )
  // Текущие лучи — в ref: rAF пишет их в DOM напрямую (без state), а JSX
  // при ре-рендере читает то же значение — рассинхрона «атрибут ↔ props» нет.
  const raysRef = useRef<number[]>(randomRays)
  const rotationRef = useRef(0)
  const lastFramesRef = useRef<typeof frames>(null)
  if (frames !== lastFramesRef.current) {
    lastFramesRef.current = frames
    const first = frames?.[0]
    raysRef.current = first ? [...first.rays] : randomRays
  }

  const polygonRef = useRef<SVGPolygonElement>(null)
  const dominantRef = useRef<SVGLineElement>(null)
  const dotRef = useRef<SVGLineElement>(null)

  /** Один кадр → атрибуты полигона и доминанты (императивно, без React). */
  const paint = useCallback((rays: readonly number[], rotationRad = 0) => {
    raysRef.current = [...rays]
    rotationRef.current = rotationRad
    const vertices = starPolygon(raysRef.current, RADIUS, CENTER_PT, rotationRad)
    const dominant = dominantPoint(vertices, CENTER_PT, RADIUS)
    polygonRef.current?.setAttribute(
      'points',
      vertices.map((vertex) => `${vertex.x},${vertex.y}`).join(' '),
    )
    // Доминанта — из центра к точке суммы; точка — нулевой штрих в ней же.
    dominantRef.current?.setAttribute('x2', String(dominant.x))
    dominantRef.current?.setAttribute('y2', String(dominant.y))
    for (const attribute of ['x1', 'y1', 'x2', 'y2'] as const) {
      const value = attribute === 'x1' || attribute === 'x2' ? dominant.x : dominant.y
      dotRef.current?.setAttribute(attribute, String(value))
    }
  }, [])

  // Анимация: пока есть кадры, каждый кадр экрана читает позицию плеера
  // (с учётом rate ×0.5; вне игры — сохранённая позиция/0) и рисует
  // интерполированные лучи. Пауза/seek → сразу слайд текущей позиции.
  useEffect(() => {
    if (!emo || !frames) return
    const hopSec = hopSeconds(emo.hop_samples, emo.fs_audio)
    let raf = 0
    const tick = () => {
      const position = getActivePlayer()?.position ?? 0
      const rays = interpolatedRays(frames, hopSec, position)
      // Плавный доворот звезды: тот же линейный интерполятор, что у лучей.
      const rotation = interpolatedRotation(rotations, frames, hopSec, position) ?? 0
      if (rays) paint(rays, rotation)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [emo, frames, rotations, paint])

  const vertices = starPolygon(raysRef.current, RADIUS, CENTER_PT, rotationRef.current)
  const dominant = dominantPoint(vertices, CENTER_PT, RADIUS)
  const polygonPoints = vertices.map((vertex) => `${vertex.x},${vertex.y}`).join(' ')
  // Облако доминант всех кадров и их суммарная точка — статика (меняется
  // только при загрузке кадров): каждая точка = доминанта своего кадра
  // **после его вращения** (спецификация 09.10.2026), суммарная = центроид
  // облака (сумма компонент / число точек) — всегда внутри облака, в отличие
  // от сырой суммы, упиравшейся в обод.
  const cloud = useMemo(
    () =>
      frames
        ? dominantCloud(
            frames.map((frame, index) => ({ rays: frame.rays, rotation: rotations[index] ?? 0 })),
            RADIUS,
            CENTER_PT,
          )
        : [],
    [frames, rotations],
  )
  const totalPoint = useMemo(
    () => (cloud.length > 0 ? totalDominant(cloud, CENTER_PT, RADIUS) : null),
    [cloud],
  )

  return (
    <svg
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
      {/* Облако доминант: точка доминанты каждого кадра анимации — мелкие
          круги ⌀5 px без заливки, обводка 1 px (позади полигона: история,
          полигон — «сейчас»). Считается один раз на загрузке кадров. */}
      {cloud.map((point, index) => (
        <circle
          key={index}
          data-part="dominant-cloud"
          cx={point.x}
          cy={point.y}
          r={2.5}
          fill="none"
          stroke="var(--color-fg-2)"
          strokeWidth={1}
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
      {/* Точка доминанты 8 px (правка 08.10.2026): нулевой штрих со
          скруглением = круг диаметра strokeWidth. */}
      <line
        ref={dotRef}
        data-part="dominant-dot"
        x1={dominant.x}
        y1={dominant.y}
        x2={dominant.x}
        y2={dominant.y}
        stroke="white"
        strokeWidth={8}
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
    </svg>
  )
}