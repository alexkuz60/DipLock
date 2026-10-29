/**
 * Активный квинтово-квартовый круг тональностей секции «ЕмоЛаб»
 * (постановка владельца 23.10.2026): в ряд со звездой-полигоном, **того же
 * диаметра** (круг-граница R = 90 единиц viewBox, как у `RadialChart`).
 *
 * Раскладка образца (akkordov.net/articles/circle-of-fifths): внешнее кольцо
 * — 12 мажоров по часовой от верха (C, G, D, A, E, B, F#, Db, Ab, Eb, Bb, F),
 * внутреннее — 12 миноров (Am, Em, …, Dm), у внешнего края — подписи знаков
 * альтерации (0, 1♯ … 1♭), в центре — имя активной тональности («C мажор»).
 *
 * **Активные подсветки** — легенда образца: тоника (заливка акцентом),
 * суб/доминанта (тёмная заливка — соседние позиции `P±1` своего кольца),
 * параллельная (обводка — та же позиция другого кольца, `Am ↔ C`), одноимённая
 * (пунктир — та же тоника другого лада, `Cm` для `C`). Роли считает
 * `keyCircle.circleHighlightRoles`, активный аккорд — как у счётчика
 * «Аккорд» (`activeKeySegment` по позиции плеера, обновление `rAF`, ре-рендер
 * только при смене тональности).
 */
import { useEffect, useRef, useState } from 'react'
import type { AudioEmo } from '@/shared/api/types'
import { getActivePlayer } from '@/shared/state/neuromusicPlayer'
import { EMO_LABELS } from './emogram'
import { frameIndexAt, hopSeconds } from '../neuromusic/emoRadar'
import { type RadialFrame, radialFrameLayout } from '../neuromusic/emoTicks'
import { activeKeySegment } from '../neuromusic/keyRotation'
import {
  CIRCLE_MAJORS,
  CIRCLE_MINORS,
  CIRCLE_SIGNATURES,
  circleCellPath,
  circleHighlightRoles,
  circleLabelPoint,
  circleNameOf,
  circleSlotOf,
  type CircleRole,
} from '../neuromusic/keyCircle'

/** Размер viewBox: квадрат 200×200, центр — посередине (как у радара). */
const VIEW = 200
const C = VIEW / 2
/** Внешний радиус круга = круг-граница радара (диаметр звезды = диаметр круга). */
const R_OUTER = 90
/** Граница колец: мажоры 58…90, миноры 30…58. */
const R_MID = 58
/** Центральный круг — имя активной тональности. */
const R_INNER = 30
/** Подписи знаков альтерации — у внешнего края. */
const R_SIG = 96.5
/** Радиусы подписей мажоров/миноров (середины колец). */
const R_MAJOR_LABEL = (R_MID + R_OUTER) / 2
const R_MINOR_LABEL = (R_INNER + R_MID) / 2

export type CircleOfFifthsProps = {
  /** Кадры «Эмо» с картой аккордов (null — круг без подсветок). */
  emo?: AudioEmo | null
}

/** Стиль ячейки по её роли (легенда образца). */
function roleStyle(role: CircleRole): {
  fill: string
  fillOpacity: number
  stroke: string
  strokeWidth: number
  strokeDasharray?: string
  text: string
} {
  switch (role) {
    case 'tonic':
      return {
        fill: 'var(--color-accent)',
        fillOpacity: 1,
        stroke: 'var(--color-accent)',
        strokeWidth: 1,
        text: 'var(--color-fg-0)',
      }
    case 'dominant':
    case 'subdominant':
      return {
        fill: 'var(--color-accent)',
        fillOpacity: 0.55,
        stroke: 'var(--color-accent)',
        strokeWidth: 1,
        text: 'var(--color-fg-0)',
      }
    case 'parallel':
      return {
        fill: 'var(--color-bg-3)',
        fillOpacity: 1,
        stroke: 'var(--color-accent)',
        strokeWidth: 2,
        text: 'var(--color-fg-0)',
      }
    case 'sameName':
      return {
        fill: 'var(--color-bg-3)',
        fillOpacity: 1,
        stroke: 'var(--color-accent)',
        strokeWidth: 2,
        strokeDasharray: '3 2',
        text: 'var(--color-fg-0)',
      }
    default:
      return {
        fill: 'var(--color-bg-3)',
        fillOpacity: 1,
        stroke: 'var(--color-border)',
        strokeWidth: 1,
        text: 'var(--color-fg-1)',
      }
  }
}
/** Одна ячейка кольца: сектор-путь + подпись по центру. */
function Cell({
  ring,
  position,
  name,
  role,
}: {
  ring: 'major' | 'minor'
  position: number
  name: string
  role: CircleRole
}) {
  const style = roleStyle(role)
  const rInner = ring === 'major' ? R_MID : R_INNER
  const rOuter = ring === 'major' ? R_OUTER : R_MID
  const label = circleLabelPoint(C, C, ring === 'major' ? R_MAJOR_LABEL : R_MINOR_LABEL, position)
  return (
    <g>
      <path
        data-part="cof-cell"
        data-ring={ring}
        data-position={position}
        data-role={role ?? 'none'}
        d={circleCellPath(C, C, rInner, rOuter, position)}
        fill={style.fill}
        fillOpacity={style.fillOpacity}
        stroke={style.stroke}
        strokeWidth={style.strokeWidth}
        strokeDasharray={style.strokeDasharray}
        vectorEffect="non-scaling-stroke"
      />
      <text
        data-part="cof-label"
        x={label.x}
        y={label.y}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={ring === 'major' ? 11 : 8.5}
        fontWeight={role === 'tonic' ? 700 : 400}
        fill={style.text}
      >
        {name}
      </text>
    </g>
  )
}

export function CircleOfFifths({ emo = null }: CircleOfFifthsProps) {
  // Активная тональность — сегмент `key_track` по позиции плеера (как у
  // счётчика «Аккорд»); обновление через rAF, ре-рендер только при смене кода.
  const frames = emo && Array.isArray(emo.frames) ? emo.frames : null
  const hopSec = emo ? hopSeconds(emo.hop_samples, emo.fs_audio) : 0
  const [keyCode, setKeyCode] = useState<number | null>(null)
  // Кадр viewBox — как у радара (`radialFrameLayout` по ячейке): одинаковые
  // ячейки колонок → одинаковый viewBox → диаметр круга = диаметр звезды
  // (инварианта «ЕмоЛаб»). Замер — ResizeObserver; в jsdom кадр по умолчанию.
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [frame, setFrame] = useState<RadialFrame>(() =>
    radialFrameLayout(EMO_LABELS, 0, 0, R_OUTER),
  )
  useEffect(() => {
    const element = svgRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const update = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setFrame(radialFrameLayout(EMO_LABELS, rect.width, rect.height, R_OUTER))
      }
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!emo) {
      setKeyCode(null)
      return
    }
    let raf = 0
    const tick = () => {
      const position = getActivePlayer()?.position ?? 0
      const frameTime =
        frames && hopSec > 0
          ? (frames[frameIndexAt(position, hopSec, frames.length)]?.t_sec ?? position)
          : position
      const segment = activeKeySegment(emo.key_track ?? null, frameTime)
      const code = segment?.key_code ?? null
      setKeyCode((prev) => (prev === code ? prev : code))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [emo, frames, hopSec])

  const roles = circleHighlightRoles(keyCode ?? Number.NaN)
  const slot = circleSlotOf(keyCode ?? Number.NaN)
  const centerName = (keyCode != null && circleNameOf(keyCode)) || '—'
  const centerMode = slot ? (slot.ring === 'major' ? 'мажор' : 'минор') : ''
  return (
    <figure data-testid="circle-of-fifths" className="flex h-full min-h-0 flex-col">
      <svg
        ref={svgRef}
        viewBox={frame.viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Квинтово-квартовый круг тональностей с подсветкой активного аккорда"
        className="min-h-0 w-full flex-1"
      >
        {/* Кольца: граница (R = 90 — диаметр радара), граница колец, центр. */}
        <circle
          data-part="cof-ring"
          cx={C}
          cy={C}
          r={R_OUTER}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={2}
        />
        <circle
          data-part="cof-ring"
          cx={C}
          cy={C}
          r={R_MID}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={1}
        />
        <circle
          data-part="cof-ring"
          cx={C}
          cy={C}
          r={R_INNER}
          fill="var(--color-bg-2)"
          stroke="var(--color-border)"
          strokeWidth={1}
        />
        {/* Внешнее кольцо — мажоры, внутреннее — миноры; подсветка — роль ячейки. */}
        {CIRCLE_MAJORS.map((name, position) => (
          <Cell
            key={`major-${position}`}
            ring="major"
            position={position}
            name={name}
            role={roles.major[position] ?? null}
          />
        ))}
        {CIRCLE_MINORS.map((name, position) => (
          <Cell
            key={`minor-${position}`}
            ring="minor"
            position={position}
            name={name}
            role={roles.minor[position] ?? null}
          />
        ))}
        {/* Подписи знаков альтерации у внешнего края (0, 1♯ … 1♭). */}
        {CIRCLE_SIGNATURES.map((sign, position) => {
          const point = circleLabelPoint(C, C, R_SIG, position)
          return (
            <text
              key={`sig-${position}`}
              data-part="cof-signature"
              x={point.x}
              y={point.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={6.5}
              fill="var(--color-fg-2)"
            >
              {sign}
            </text>
          )
        })}
        {/* Центр — имя активной тональности («C мажор»), как на образце. */}
        <text
          data-part="cof-center-name"
          x={C}
          y={C - 4}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={15}
          fontWeight={700}
          fill="var(--color-fg-0)"
        >
          {centerName}
        </text>
        <text
          data-part="cof-center-mode"
          x={C}
          y={C + 12}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={8}
          fill="var(--color-fg-2)"
        >
          {centerMode}
        </text>
      </svg>
      {/* Легенда подсветок (образец): тоника, суб/доминанта, параллельная,
          одноимённая. Высота строки = пустой подвал радара в `EmoLabSection` —
          диаметры круга и звезды совпадают. */}
      <figcaption
        data-part="cof-legend"
        className="flex h-6 shrink-0 items-center justify-center gap-3 text-xs text-fg-2"
      >
        <span className="flex items-center gap-1">
          <svg width="10" height="10" aria-hidden="true">
            <circle cx="5" cy="5" r="4" fill="var(--color-accent)" />
          </svg>
          тоника
        </span>
        <span className="flex items-center gap-1">
          <svg width="10" height="10" aria-hidden="true">
            <circle cx="5" cy="5" r="4" fill="var(--color-accent)" fillOpacity={0.55} />
          </svg>
          суб/доминанта
        </span>
        <span className="flex items-center gap-1">
          <svg width="10" height="10" aria-hidden="true">
            <circle cx="5" cy="5" r="3.5" fill="none" stroke="var(--color-accent)" strokeWidth={2} />
          </svg>
          параллельная
        </span>
        <span className="flex items-center gap-1">
          <svg width="10" height="10" aria-hidden="true">
            <circle
              cx="5"
              cy="5"
              r="3.5"
              fill="none"
              stroke="var(--color-accent)"
              strokeWidth={2}
              strokeDasharray="2 1.5"
            />
          </svg>
          одноимённая
        </span>
      </figcaption>
    </figure>
  )
}