/**
 * Тесты разметки ½ сектора и надписей классификатора эмоций вокруг радара
 * (`emoTicks.ts`): углы 14 тиков, оценка ширины текста, раскладка подписей
 * с гарантированным зазором 10 px от окружности (ближайшая точка текст-бокса
 * не перекрывает круг ни при каком масштабе `pxPerUnit`).
 */
import { describe, expect, it } from 'vitest'
import { EMO_LABELS } from '../emolab/emogram'
import { SEGMENT_START } from './radialChart'
import {
  EMO_TICK_COUNT,
  LABEL_FONT_PX,
  LABEL_GAP_PX,
  LABEL_SHIFT_PX,
  emoLabelLayout,
  emoTickAngles,
  estimateTextWidthPx,
  radialFrameLayout,
} from './emoTicks'

const CENTER = { x: 100, y: 100 }
const RADIUS = 90

describe('emoTicks', () => {
  it('углы тиков: 14 позиций с шагом π/7 = ½ сектора, первый — SEGMENT_START', () => {
    const angles = emoTickAngles()
    expect(angles).toHaveLength(EMO_TICK_COUNT)
    expect(angles[0]).toBeCloseTo(SEGMENT_START, 12)
    for (let index = 1; index < angles.length; index++) {
      expect(angles[index] - angles[index - 1]).toBeCloseTo(Math.PI / 7, 12)
    }
    // Чётные тики совпадают с лучами-разделителями секторов (шаг 2π/7).
    for (let index = 0; index < angles.length; index += 2) {
      expect(angles[index]).toBeCloseTo(SEGMENT_START + (index / 2) * ((2 * Math.PI) / 7), 12)
    }
  })

  it('estimateTextWidthPx: растёт с длиной текста, непустая', () => {
    expect(estimateTextWidthPx('')).toBe(0)
    expect(estimateTextWidthPx('страх')).toBeGreaterThan(0)
    expect(estimateTextWidthPx('безразличие')).toBeGreaterThan(estimateTextWidthPx('страх'))
  })

  it('radialFrameLayout (jsdom, без замера): масштаб 1, viewBox по худшему выступу', () => {
    const frame = radialFrameLayout(EMO_LABELS, 0, 0, RADIUS)
    expect(frame.pxPerUnit).toBe(1)
    // Худший выступ — «уверенность» у горизонтали (правка 30.10.2026):
    // (R + 10 + halfW·|cosθ| + halfH·|sinθ|)·|cosθ| + halfW ≈ 178.9 px →
    // полусторона 179, центр (100/100) сохраняется.
    expect(frame.viewBox).toBe('-79 -79 358 358')
    const [x, y, w, h] = frame.viewBox.split(' ').map(Number)
    expect(x + w / 2).toBe(100)
    expect(y + h / 2).toBe(100)
    expect(w).toBe(h)
  })

  it('radialFrameLayout (ячейка): все надписи умещаются, пропорции = ячейке', () => {
    for (const [wPx, hPx] of [
      [440, 400],
      [800, 500],
      [360, 640],
    ]) {
      const frame = radialFrameLayout(EMO_LABELS, wPx, hPx, RADIUS)
      const [x, y, w, h] = frame.viewBox.split(' ').map(Number)
      // viewBox подогнан под ячейку по пропорциям (с точностью округления
      // viewBox до сотых), центр графика — (100/100).
      expect(w / h).toBeCloseTo(wPx / hPx, 2)
      // Центр графика — (100/100) с точностью округления viewBox (до сотых).
      expect(x + w / 2).toBeCloseTo(100, 1)
      expect(y + h / 2).toBeCloseTo(100, 1)
      // Круг вписан: радиус ≤ половины меньшей стороны ячейки.
      expect(RADIUS * frame.pxPerUnit).toBeLessThanOrEqual(Math.min(wPx, hPx) / 2)
      // Внешние box'и надписей не вылезают за ячейку (в px).
      const layout = emoLabelLayout(EMO_LABELS, RADIUS, CENTER, frame.pxPerUnit)
      layout.forEach((item, index) => {
        const halfWidth = estimateTextWidthPx(EMO_LABELS[index]) / 2
        const halfHeight = (LABEL_FONT_PX * 1.2) / 2
        expect(Math.abs(item.x - CENTER.x) * frame.pxPerUnit + halfWidth).toBeLessThanOrEqual(
          wPx / 2 + 1e-6,
        )
        expect(Math.abs(item.y - CENTER.y) * frame.pxPerUnit + halfHeight).toBeLessThanOrEqual(
          hPx / 2 + 1e-6,
        )
      })
    }
  })

  it('круг растёт с ячейкой (правка «до высоты гистограммы»): масштаб > 1', () => {
    // Типичная широкая колонка таба «Звезда» (flex-[2]): круг ≈ высота ячейки
    // за вычетом полей под надписи — заметно больше прежних 53 %.
    const frame = radialFrameLayout(EMO_LABELS, 620, 420, RADIUS)
    expect(frame.pxPerUnit).toBeGreaterThan(1)
    expect(2 * RADIUS * frame.pxPerUnit).toBeGreaterThan(420 * 0.8)
  })

  it('раскладка: 14 надписей по кругу, подпись i — у тика i (против часовой)', () => {
    const layout = emoLabelLayout(EMO_LABELS, RADIUS, CENTER, 1)
    expect(layout.map((item) => item.label)).toEqual([...EMO_LABELS])
    const angles = emoTickAngles()
    layout.forEach((item, index) => {
      const angle = angles[index]
      // Направление от центра к надписи = угол тика (y в SVG вниз — знак минус).
      const direction = Math.atan2(CENTER.y - item.y, item.x - CENTER.x)
      const normalized = ((direction % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      const expected = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
      expect(normalized).toBeCloseTo(expected, 9)
    })
  })

  it('зазор 10 px: ближайшая точка текст-бокса не перекрывает окружность', () => {
    for (const pxPerUnit of [0.75, 1, 2]) {
      const layout = emoLabelLayout(EMO_LABELS, RADIUS, CENTER, pxPerUnit)
      layout.forEach((item, index) => {
        const halfWidth = estimateTextWidthPx(EMO_LABELS[index]) / 2
        const halfHeight = (LABEL_FONT_PX * 1.2) / 2 // LABEL_LINE_EM = 1.2
        // Ближайшая точка box'а к центру: выступ box'а по обеим осям.
        const dx = Math.max(0, Math.abs(item.x - CENTER.x) * pxPerUnit - halfWidth)
        const dy = Math.max(0, Math.abs(item.y - CENTER.y) * pxPerUnit - halfHeight)
        const nearestPx = Math.hypot(dx, dy)
        expect(nearestPx).toBeGreaterThanOrEqual(RADIUS * pxPerUnit + LABEL_GAP_PX - 1e-9)
      })
    }
  })

  it('вертикальные надписи (правка 27.10.2026 (2)): «эйфория» ↑, «безразличие» ↓, зазор 15 px', () => {
    // «эйфория» (i = 13) — угол π/2 (верх круга), «безразличие» (i = 6) —
    // 3π/2 (низ): обе строго на вертикали, box ориентирован по вертикали,
    // зазор = gap + shift = 15 px, сдвиг — наружу от центра.
    const layout = emoLabelLayout(EMO_LABELS, RADIUS, CENTER, 1)
    const top = layout[13]
    const bottom = layout[6]
    expect(top.label).toBe('эйфория')
    expect(bottom.label).toBe('безразличие')
    for (const item of [top, bottom]) {
      const nearest = Math.hypot(
        Math.max(0, Math.abs(item.x - CENTER.x) - estimateTextWidthPx(item.label) / 2),
        Math.max(0, Math.abs(item.y - CENTER.y) - (LABEL_FONT_PX * 1.2) / 2),
      )
      expect(nearest).toBeCloseTo(RADIUS + LABEL_GAP_PX + LABEL_SHIFT_PX, 6)
    }
    // Направления сдвигов: «эйфория» выше центра, «безразличие» — ниже.
    expect(top.y).toBeLessThan(CENTER.y)
    expect(bottom.y).toBeGreaterThan(CENTER.y)
    // Остальные надписи (в т.ч. соседние «страх/агрессия»/«трагедия») — зазор ровно 10 px.
    const fear = layout[0]
    const fearNearest = Math.hypot(
      Math.max(0, Math.abs(fear.x - CENTER.x) - estimateTextWidthPx(fear.label) / 2),
      Math.max(0, Math.abs(fear.y - CENTER.y) - (LABEL_FONT_PX * 1.2) / 2),
    )
    expect(fearNearest).toBeGreaterThanOrEqual(RADIUS + LABEL_GAP_PX - 1e-9)
  })
})