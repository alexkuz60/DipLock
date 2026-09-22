/**
 * Тесты опций трека uPlot (срез 2.5/2.8).
 *
 * Модуль чистый, поэтому проверяется без DOM и без jsdom-чарта: точность подписей
 * оси времени зависит от всего окна, диапазон амплитуды — от режима шкалы,
 * а опции чарта обязаны держать общую ось времени (включена только у нижнего
 * трека) и огибающую как band. Ошибка здесь не видна в тестах компонента —
 * там uPlot замокан, поэтому арифметика проверяется отдельно.
 */
import { describe, expect, it, vi } from 'vitest'
import type uPlot from 'uplot'
import {
  EXPANDED_TRACK_HEIGHT,
  LABEL_WIDTH,
  TRACK_HEIGHT,
  expandRangeWithZero,
  formatTick,
  makeTrackOptions,
  yRangeFor,
  type ShowZeroFlag,
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

  it('высота развёрнутого трека — фикс ×8 к превью, а не «высота области» (решение 22.09.2026)', () => {
    // Развёрнутый вид — стабильный «холст» под будущие слои (артефакты, «до/после» чистки);
    // константа не зависит от замера ResizeObserver и не может завести петлю роста DOM
    expect(EXPANDED_TRACK_HEIGHT).toBe(512)
    expect(EXPANDED_TRACK_HEIGHT).toBe(TRACK_HEIGHT * 8)
  })
})

describe('ноль развёрнутого трека: диапазон Y и линия нуля (срез 5, п. 1/2)', () => {
  it('expandRangeWithZero включает ноль в диапазон Y всегда', () => {
    // Ноль уже в кадре — диапазон не трогаем
    expect(expandRangeWithZero([-10, 20])).toEqual([-10, 20])
    expect(expandRangeWithZero([-1, 1])).toEqual([-1, 1])
    // Сигнал одной полярности — ноль включается с зазором 5% спана, а не ложится на край
    expect(expandRangeWithZero([1, 2])).toEqual([-0.05, 2])
    expect(expandRangeWithZero([-2, -1])).toEqual([-2, 0.05])
    // Ноль на границе кадра тоже получает зазор
    expect(expandRangeWithZero([0, 5])).toEqual([-0.25, 5])
    expect(expandRangeWithZero([-5, 0])).toEqual([-5, 0.25])
    // Вырожденный/битый диапазон — безопасный симметричный
    expect(expandRangeWithZero([2, 2])).toEqual([-1, 1])
    expect(expandRangeWithZero([NaN, 1])).toEqual([-1, 1])
  })

  it('хук drawClear рисует пунктир нуля стилем линии отсчёта «ЭЭГ» и гейтится живым флагом', () => {
    const flag: ShowZeroFlag = { current: true }
    const options = makeTrackOptions(960, 512, WINDOW, [-20, 20], false, flag)
    const hook = (options.hooks as { drawClear?: Array<(chart: uPlot) => void> }).drawClear?.[0]
    expect(hook).toBeTypeOf('function')

    const ctx = {
      save: vi.fn(),
      beginPath: vi.fn(),
      setLineDash: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      restore: vi.fn(),
      strokeStyle: '',
      globalAlpha: 1,
      lineWidth: 0,
    }
    const chart = {
      ctx,
      bbox: { left: 3, top: 0, width: 100, height: 512 },
      valToPos: vi.fn(() => 42.4),
    }
    hook?.(chart as unknown as uPlot)

    // Стиль — как у `eegCanvas.drawNullLine`: пунктир [5, 4]×pxRatio (в моке pxRatio = 1)
    expect(ctx.setLineDash).toHaveBeenCalledWith([5, 4])
    expect(ctx.strokeStyle).toBe('#c3ceda')
    expect(ctx.globalAlpha).toBe(0.4)
    // Координаты — только через valToPos (canvas-пиксели), y = Math.round(42.4) + 0.5
    expect(chart.valToPos).toHaveBeenCalledWith(0, 'y', true)
    expect(ctx.moveTo).toHaveBeenCalledWith(3, 42.5)
    expect(ctx.lineTo).toHaveBeenCalledWith(103, 42.5)
    expect(ctx.stroke).toHaveBeenCalled()

    // Живой флаг: превью того же чарта линию не рисует — опции при этом те же (P1/P4)
    ctx.setLineDash.mockClear()
    flag.current = false
    hook?.(chart as unknown as uPlot)
    expect(ctx.setLineDash).not.toHaveBeenCalled()
    expect(ctx.stroke).toHaveBeenCalledTimes(1)
  })

  it('без showZero хука drawClear нет', () => {
    expect(makeTrackOptions(960, 64, WINDOW, [-20, 20], true).hooks?.drawClear).toBeUndefined()
  })
})
