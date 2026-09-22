/**
 * Опции трека uPlot и шкала амплитуды вьюера ЭЭГ (правило
 * `docs/rules/frontend-state.md` п.6: чистая логика — в `shared/lib`, компонент
 * рисует, но не считает).
 *
 * Функции чистые: на вход — ширина, окно времени, диапазон Y и признак оси
 * времени, на выход — готовый объект опций uPlot. Поэтому их можно проверить
 * тестом без DOM и без React, а `TrackStack.tsx` остаётся компонентом: он
 * создаёт чарт, обновляет данные и разбирает жесты.
 *
 * Цвета заданы hex-константами: canvas не читает CSS-токены, значения
 * синхронизированы с темой (`styles/index.css`: `--color-accent` #4da3ff,
 * `--color-fg-2` #8695a8, `--color-border`).
 */
import type uPlot from 'uplot'
import type { TimeWindow } from './viewerMath'

const STROKE = '#4da3ff'
const ENVELOPE_FILL = 'rgba(77, 163, 255, 0.22)'
const AXIS_TEXT = '#8695a8'
const AXIS_GRID = 'rgba(44, 58, 77, 0.6)'

/** Высота одного трека и ширина колонки подписей каналов. */
export const TRACK_HEIGHT = 64
export const LABEL_WIDTH = 56
/**
 * Высота развёрнутого трека — фиксированная, ×8 к превью (решение владельца 22.09.2026):
 * развёрнутый вид — стабильный «холст» под будущие слои (вертикальный зум сигнала, артефакты,
 * сравнение «до/после» чистки), и константа не может завести петлю «высота → контент → замер»
 * (`docs/rules/frontend-perf.md` п. 3.7).
 */
export const EXPANDED_TRACK_HEIGHT = TRACK_HEIGHT * 8

/** Подпись деления оси времени: точность зависит от всего окна (2 с / 0.1 с). */
export function formatTick(spanSec: number, value: number): string {
  const digits = spanSec >= 60 ? 0 : spanSec >= 5 ? 1 : 2
  return `${value.toFixed(digits)} с`
}

/** Диапазон оси Y: общий (±N мкВ) или авто по окну канала. */
export function yRangeFor(
  mode: 'shared' | 'per_channel',
  scaleUv: number,
  envMin: number,
  envMax: number,
): [number, number] {
  if (mode === 'shared') return [-scaleUv, scaleUv]
  if (!Number.isFinite(envMin) || !Number.isFinite(envMax) || envMax <= envMin) return [-1, 1]
  const pad = (envMax - envMin) * 0.08
  return [envMin - pad, envMax + pad]
}

/**
 * Опции одного трека: общая ось времени (у нижнего трека), огибающая min/max
 * как band (пики артефактов видны на любом зуме) и отключённые собственные
 * жесты чарта — окном управляет обёртка вьюера.
 */
export function makeTrackOptions(
  width: number,
  height: number,
  window: TimeWindow,
  yRange: [number, number],
  showXAxis: boolean,
): uPlot.Options {
  return {
    width,
    height,
    legend: { show: false },
    cursor: { show: false },
    padding: [4, 4, 0, 0],
    scales: {
      x: { time: false, min: window.t0, max: window.t1 },
      y: { range: yRange },
    },
    axes: [
      showXAxis
        ? {
            stroke: AXIS_TEXT,
            font: '12px system-ui',
            grid: { stroke: AXIS_GRID, width: 1 },
            ticks: { show: false },
            size: 26,
            values: (self, splits) => {
              const span = self.scales.x.max! - self.scales.x.min!
              return splits.map((v) => formatTick(span, v))
            },
          }
        : { show: false },
      { show: false },
    ],
    series: [
      {},
      // min — невидимая опорная серия огибающей (нужна band'у)
      { show: true, points: { show: false }, stroke: 'rgba(0,0,0,0)', width: 0.1 },
      // max — видимая линия трека
      { show: true, points: { show: false }, stroke: STROKE, width: 1.25 },
    ],
    bands: [{ series: [2, 1], fill: ENVELOPE_FILL, dir: 1 }],
  }
}
