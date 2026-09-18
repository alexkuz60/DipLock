/**
 * Тесты опций трека uPlot (срез 2.5/2.8).
 *
 * Модуль чистый, поэтому проверяется без DOM и без jsdom-чарта: точность подписей
 * оси времени зависит от всего окна, диапазон амплитуды — от режима шкалы,
 * а опции чарта обязаны держать общую ось времени (включена только у нижнего
 * трека) и огибающую как band. Ошибка здесь не видна в тестах компонента —
 * там uPlot замокан, поэтому арифметика проверяется отдельно.
 */
import { describe, expect, it } from 'vitest'
import {
  LABEL_WIDTH,
  TRACK_HEIGHT,
  formatTick,
  makeTrackOptions,
  yRangeFor,
} from './trackOptions'
import type { TimeWindow } from './viewerMath'

const WINDOW: TimeWindow = { t0: 4.375, t1: 5.625 }

describe('опции трека uPlot', () => {
  it('подписывает деления с точностью по всему окну', () => {
    // Короткое окно — сотые, минута и больше — целые секунды: подпись не «плывёт»
    expect(formatTick(2, 1.25)).toBe('1.25 с')
    expect(formatTick(10, 1.25)).toBe('1.3 с')
    expect(formatTick(120, 1.25)).toBe('1 с')
  })

  it('даёт общий и поканальный диапазон амплитуды', () => {
    expect(yRangeFor('shared', 50, -10, 10)).toEqual([-50, 50])

    // Режим «по каналу» ужимает шкалу под видимую огибающую с паддингом 8%
    const [lo, hi] = yRangeFor('per_channel', 50, -10, 10)
    expect(lo).toBeLessThan(-10)
    expect(hi).toBeGreaterThan(10)
    expect(-10 - lo).toBeCloseTo(hi - 10, 9)
  })

  it('не отдаёт вырожденную шкалу при пустой огибающей', () => {
    // Канал без сигнала или NaN в кадре: диапазон по умолчанию, а не [Infinity, -Infinity]
    expect(yRangeFor('per_channel', 50, Number.NaN, 0)).toEqual([-1, 1])
    expect(yRangeFor('per_channel', 50, 5, 5)).toEqual([-1, 1])
    expect(yRangeFor('per_channel', 50, 10, -10)).toEqual([-1, 1])
  })

  it('строит чарт по окну вьюера: ось времени у нижнего трека, band огибающей', () => {
    const bottom = makeTrackOptions(600, TRACK_HEIGHT, WINDOW, [-50, 50], true)
    expect(bottom.width).toBe(600)
    expect(bottom.height).toBe(TRACK_HEIGHT)
    // Ось X — время в секундах, границы — из окна (не из данных): окном управляет вьюер
    expect(bottom.scales?.x).toMatchObject({ time: false, min: WINDOW.t0, max: WINDOW.t1 })
    expect(bottom.scales?.y).toMatchObject({ range: [-50, 50] })
    expect(bottom.axes?.[0]).not.toMatchObject({ show: false })

    // Ось времени только у нижнего трека: у остальных она выключена (общая ось)
    const upper = makeTrackOptions(600, TRACK_HEIGHT, WINDOW, [-50, 50], false)
    expect(upper.axes?.[0]).toMatchObject({ show: false })

    // Собственные жесты чарта и легенда выключены: жесты разбирает обёртка (`TrackStack`)
    expect(bottom.legend?.show).toBe(false)
    expect(bottom.cursor?.show).toBe(false)

    // Три серии: ось X + невидимый min (опора band'а) + видимая линия max
    expect(bottom.series).toHaveLength(3)
    expect(bottom.series?.[1]).toMatchObject({ show: true, stroke: 'rgba(0,0,0,0)' })
    expect(bottom.series?.[2]).toMatchObject({ show: true, stroke: '#4da3ff' })
    expect(bottom.bands?.[0]).toMatchObject({ series: [2, 1], dir: 1 })
  })

  it('держит общую геометрию с колонкой подписей и слоями', () => {
    // Эти числа делят вьюер и слои (`TrackLayers`, курсор): смена ломает выравнивание
    expect(LABEL_WIDTH).toBe(56)
    expect(TRACK_HEIGHT).toBe(64)
  })
})
