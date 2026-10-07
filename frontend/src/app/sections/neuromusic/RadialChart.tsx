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
 * Пока длина лучей — **случайный рандомизатор 0.1…1.0 R**
 * (`randomRayPercents`, один раз на монтирование — без «прыжков» при
 * ре-рендерах); расчёт по спектральной мощности и динамика при
 * воспроизведении — отдельные темы. Полигон: заливка жёлтым с прозрачностью
 * 0.25, грани — сплошные линии 2 px; доминанта — белая линия и точка 4 px
 * (точки/линии в экранных пикселях — `vector-effect="non-scaling-stroke"`).
 * Геометрия — чистый модуль `radialChart.ts`; отрисовка SVG, как у соседнего
 * силуэта `BrainRoomView`.
 */
import { useMemo } from 'react'
import {
  GRID_FRACTIONS,
  dominantPoint,
  pointAt,
  randomRayPercents,
  segmentBoundaries,
  starPolygon,
} from './radialChart'

/** Размер viewBox: квадрат 200×200, центр — посередине. */
const VIEW = 200
const CENTER = VIEW / 2
/** Радиус графика (круг-граница), единиц viewBox: оси и лучи до него. */
const RADIUS = 90
/** Центр графика — константа модуля (стабильна для `useMemo`). */
const CENTER_PT = { x: CENTER, y: CENTER }

export function RadialChart() {
  const boundaries = segmentBoundaries()
  // Случайные лучи 0.1…1.0 R — один раз на монтирование: до подключения
  // расчёта полигон не должен меняться от ре-рендеров (transport/store).
  const vertices = useMemo(() => starPolygon(randomRayPercents(), RADIUS, CENTER_PT), [])
  const dominant = dominantPoint(vertices, CENTER_PT, RADIUS)
  const polygonPoints = vertices.map((vertex) => `${vertex.x},${vertex.y}`).join(' ')

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
      {/* Полигон («звезда»): случайные лучи 0.1…1.0 R; заливка жёлтой с
          прозрачностью 0.25, грани — сплошные (не прозрачные) 2 px. */}
      <polygon
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
        data-part="dominant"
        x1={CENTER}
        y1={CENTER}
        x2={dominant.x}
        y2={dominant.y}
        stroke="white"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
      {/* Точка доминанты 4 px: нулевой штрих со скруглением = круг 4 px. */}
      <line
        data-part="dominant-dot"
        x1={dominant.x}
        y1={dominant.y}
        x2={dominant.x}
        y2={dominant.y}
        stroke="white"
        strokeWidth={4}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}