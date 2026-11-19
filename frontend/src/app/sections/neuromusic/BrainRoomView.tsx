/**
 * Силуэт BrainRoom для секции «Визуализация» «Нейромузыки» (вид сверху):
 * стены комнаты 1.0 : 1.3, контур мозга с продольной щелью, слушатель в центре.
 *
 * **«Монтаж» (дипольный рендер, срез 19.11.2026):** вместо точек сцены —
 * маркеры полос из `extensions.dipoles` sidecar (`dipoleScene.ts`):
 * вращающаяся вокруг собственного центра **восьмёрка (∞)** по углу момента
 * диполя; цвет — полосный (`bandColors`), размер — стереобаза полосы,
 * прозрачность заливки — сила диполя, размытость границы окружности —
 * глубина (уход z вниз по коронарному срезу). Анимация по позиции плеера —
 * `rAF` пишет атрибуты **через refs, без ре-рендеров React**
 * (`docs/rules/frontend-perf.md`, паттерн `RadialChart`); до плей и на паузе
 * показывается слайд текущей позиции. Без сцены (старый рендер/ошибка
 * sidecar) — прежние статичные точки дуги.
 *
 * Экономия места (правка 10.10.2026): текст-легенда убрана, SVG —
 * `h-full w-full` с `preserveAspectRatio="xMidYMid meet"`.
 */
import { useEffect, useMemo, useRef } from 'react'
import { bandColor } from '@/shared/lib/bandColors'
import {
  dipoleSceneAt,
  infinityPath,
  markerBlurPx,
  markerRadius,
  type DipoleScene,
  type DipoleSceneSample,
} from '@/shared/lib/dipoleScene'
import { brainroomProject, scenePoints } from '@/shared/lib/spatialLayout'
import { getActivePlayer } from '@/shared/state/neuromusicPlayer'
import { BAND_HZ, BAND_ORDER } from './bandLabels'

/** Размер viewBox: ширина 1.0, длина 1.3 — ровно пропорции стен. */
const VIEW_W = 200
const VIEW_H = 260
const PAD = 12
/** Полуоси стен (px): длина = ширина × 1.3. */
const WALL_RX = VIEW_W / 2 - PAD
const WALL_RY = WALL_RX * 1.3
/** Контур мозга чуть меньше стен. */
const BRAIN_RX = WALL_RX - 10
const BRAIN_RY = BRAIN_RX * 1.3
/** Максимальная размытость границы окружности (полная глубина «колодца»). */
const MAX_BLUR_PX = 6

export type BrainRoomViewProps = {
  /** Вариант рендера: «Монтаж» — маркеры дипольной сцены, «Экспресс» — дуга */
  variant: 'express' | 'montage'
  /** Число полос (точки дуги «Экспресса») */
  bands: number
  /** Разброс из «Пространства», % — дуга «Экспресса» живёт от ползунка */
  spreadPct: number
  /** Дипольная сцена «Монтажа» (sidecar.extensions.dipoles); без неё — дуга */
  scene?: DipoleScene | null
}

/** Маркер полосы: центр ∞ (px viewBox) из позиции MNI + поворот в градусах. */
function markerCenter(
  sample: DipoleSceneSample,
  scene: DipoleScene,
): { cx: number; cy: number; rotationDeg: number } {
  const center = { x: VIEW_W / 2, y: VIEW_H / 2 }
  const u = Math.min(1, Math.max(-1, sample.x / scene.mni_half_x_mm))
  const v = Math.min(1, Math.max(-1, sample.y / (scene.mni_half_x_mm * 1.3)))
  return {
    cx: center.x + u * WALL_RX,
    cy: center.y - v * WALL_RY,
    rotationDeg: (sample.theta * 180) / Math.PI,
  }
}

export function BrainRoomView({ variant, bands, spreadPct, scene }: BrainRoomViewProps) {
  const bandCount = Math.max(1, bands)
  const dipoleBands = useMemo(
    () => (variant === 'montage' && scene ? BAND_ORDER.filter((band) => scene.bands[band]) : []),
    [variant, scene],
  )
  /** Refs маркеров ∞: rAF пишет transform/атрибуты без ре-рендеров. */
  const markerRefs = useRef(new Map<string, SVGGElement | null>())
  const circleRefs = useRef(new Map<string, SVGCircleElement | null>())
  const pathRefs = useRef(new Map<string, SVGPathElement | null>())
  const infinityD = useMemo(() => infinityPath(1), [])

  // Статичная позиция монтирования (слайд позиции 0) — ре-рендеры не «прыгают».
  const initialSamples = useMemo(() => {
    const map = new Map<
      string,
      { sample: DipoleSceneSample; cx: number; cy: number; rotationDeg: number }
    >()
    if (!scene) return map
    for (const band of dipoleBands) {
      const sample = dipoleSceneAt(scene.bands[band], 0, scene.depth_z_mm)
      if (sample) map.set(band, { sample, ...markerCenter(sample, scene) })
    }
    return map
  }, [dipoleBands, scene])

  useEffect(() => {
    if (!scene || dipoleBands.length === 0) return
    let frame = 0
    const paint = () => {
      const tSec = getActivePlayer()?.position ?? 0
      for (const band of dipoleBands) {
        const sample = dipoleSceneAt(scene.bands[band], tSec, scene.depth_z_mm)
        const group = markerRefs.current.get(band)
        if (!sample || !group) continue
        const { cx, cy, rotationDeg } = markerCenter(sample, scene)
        group.setAttribute('transform', `translate(${cx}, ${cy}) rotate(${rotationDeg})`)
        group.setAttribute('data-strength', sample.strength.toFixed(3))
        group.setAttribute('data-depth', sample.depth.toFixed(3))
        const circle = circleRefs.current.get(band)
        if (circle) {
          circle.style.filter = `blur(${markerBlurPx(sample.depth, MAX_BLUR_PX).toFixed(2)}px)`
        }
        const path = pathRefs.current.get(band)
        if (path) path.setAttribute('opacity', sample.strength.toFixed(3))
      }
      frame = requestAnimationFrame(paint)
    }
    frame = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(frame)
  }, [dipoleBands, scene])

  const points =
    variant === 'montage' && scene
      ? []
      : scenePoints({
          bands: bandCount,
          spread: Math.min(1, Math.max(0, spreadPct / 100)),
        })
  const center = { x: VIEW_W / 2, y: VIEW_H / 2 }
  /** Точка сцены → SVG: u вправо, v вверх (фронт наверху схемы). */
  const toXY = (x: number, z: number) => {
    const { u, v } = brainroomProject(x, z)
    return { cx: center.x + u * WALL_RX, cy: center.y - v * WALL_RY }
  }
  const brainTop = center.y - BRAIN_RY
  const brainBottom = center.y + BRAIN_RY

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={
        variant === 'montage' && scene
          ? 'Силуэт головы: вид сверху, дипольная сцена «Монтажа» — восьмёрки полос'
          : `Силуэт BrainRoom: вид сверху, ${variant === 'montage' ? 'модули рядов' : 'дуга ±60°'}`
      }
      data-testid="brainroom-view"
      className="h-full w-full"
    >
      {/* Стены BrainRoom: эллипс 1.0 : 1.3, слушатель в центре. */}
      <ellipse
        cx={center.x}
        cy={center.y}
        rx={WALL_RX}
        ry={WALL_RY}
        fill="var(--color-bg-1)"
        stroke="var(--color-border)"
        strokeWidth={2}
      />
      {/* Мозг сверху: овал коры + продольная щель + выступ носа спереди. */}
      <ellipse
        cx={center.x}
        cy={center.y}
        rx={BRAIN_RX}
        ry={BRAIN_RY}
        fill="none"
        stroke="var(--color-fg-2)"
        strokeWidth={1.5}
      />
      <line
        x1={center.x}
        y1={brainTop + 6}
        x2={center.x}
        y2={brainBottom - 6}
        stroke="var(--color-fg-2)"
        strokeWidth={1}
        strokeDasharray="4 5"
      />
      <path
        d={`M ${center.x - 6} ${brainTop} L ${center.x} ${brainTop - 7} L ${center.x + 6} ${brainTop} Z`}
        fill="var(--color-fg-2)"
      />
      {/* Слушатель (y=0, сцена XY): белая точка + прицел. */}
      <line
        x1={center.x - 8}
        y1={center.y}
        x2={center.x + 8}
        y2={center.y}
        stroke="var(--color-fg-0)"
        strokeWidth={1}
      />
      <line
        x1={center.x}
        y1={center.y - 8}
        x2={center.x}
        y2={center.y + 8}
        stroke="var(--color-fg-0)"
        strokeWidth={1}
      />
      <circle cx={center.x} cy={center.y} r={3.5} fill="var(--color-fg-0)" />
      {/* Маркеры дипольной сцены («Монтаж»): восьмёрка + окружность на полосу. */}
      {scene &&
        dipoleBands.map((band) => {
          const initial = initialSamples.get(band)
          const base = scene.bands[band]
          const radius = markerRadius(base.stereo_base)
          const color = bandColor(BAND_HZ[band] ?? [1, 2])
          const position = initial
            ? `translate(${initial.cx}, ${initial.cy}) rotate(${initial.rotationDeg})`
            : undefined
          return (
            <g
              key={band}
              ref={(node) => {
                markerRefs.current.set(band, node)
              }}
              transform={position}
              data-testid={`dipole-marker-${band}`}
              data-strength={initial ? initial.sample.strength.toFixed(3) : undefined}
              data-depth={initial ? initial.sample.depth.toFixed(3) : undefined}
            >
              <circle
                ref={(node) => {
                  circleRefs.current.set(band, node)
                }}
                r={radius}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
              />
              <path
                ref={(node) => {
                  pathRefs.current.set(band, node)
                }}
                d={infinityD}
                transform={`scale(${radius * 0.72})`}
                fill={color}
                opacity={initial ? initial.sample.strength : 1}
              />
            </g>
          )
        })}
      {/* Источники сцены «Экспресса» (и фоллбэк без сцены). */}
      {points.map((point, index) => {
        const { cx, cy } = toXY(point.x, point.z)
        return (
          <circle
            key={`arc-${index}`}
            cx={cx}
            cy={cy}
            r={3.2}
            fill="var(--color-accent)"
            stroke="var(--color-bg-0)"
            strokeWidth={1}
          />
        )
      })}
    </svg>
  )
}