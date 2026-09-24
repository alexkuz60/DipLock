/**
 * Тесты геометрии и шкал раздела «ЭЭГ» (срез 5).
 *
 * Проверяется то, что глазами не поймать: общая левая граница графика у двух
 * половин (иначе общий курсор не совпал бы по вертикали), зажим разделителя по
 * минимальным высотам, деления линеек значений (мкВ/деление, частоты, время),
 * арифметика перетаскивания линеек (она меняет шкалу, но не запускает расчёт) и
 * рамка видимой части записи на «обзоре» — по ней видно, какой отрезок открыт
 * на треке и где внутри него стоит выбранная позиция.
 */
import { describe, expect, it } from 'vitest'
import {
  AMPLITUDE_DIVISIONS,
  AMPLITUDE_UV_PER_DIV,
  EEG_LABEL_W,
  EEG_MIN_HALF_H,
  EEG_SPLITTER_H,
  EEG_VALUE_W,
  ampTicks,
  amplitudeRangeUv,
  clampSplitRatio,
  dragAmplitudeUv,
  dragFreqWindow,
  eegWindow,
  fmaxToY,
  formatAxisTime,
  formatHzTick,
  formatUvLevel,
  freqTicks,
  halfCanvasHeight,
  niceStep,
  normalizeAmplitudeUv,
  plotLeftPx,
  plotRightPx,
  plotTimeAtX,
  plotTimeX,
  plotWidthPx,
  splitHeights,
  stepAmplitudeUv,
  timeInWindow,
  timeTicks,
  valueToY,
  windowFrame,
  yToAmplitudeUv,
  yToFreq,
  yToValue,
} from './eegView'

describe('геометрия половин', () => {
  it('держит одну левую границу и одинаковый столбец значений у обеих половин', () => {
    // Общий курсор и совпадение шкал возможны только при одной геометрии:
    // ширина графика = контейнер − подпись слева − значения справа
    const width = 1200
    expect(plotLeftPx()).toBe(EEG_LABEL_W)
    expect(plotRightPx(width)).toBe(width - EEG_VALUE_W)
    expect(plotWidthPx(width)).toBe(width - EEG_LABEL_W - EEG_VALUE_W)
    expect(plotWidthPx(width)).toBe(plotRightPx(width) - plotLeftPx())
  })

  it('не отдаёт отрицательную ширину на узком контейнере', () => {
    expect(plotWidthPx(0)).toBe(0)
    expect(plotWidthPx(100)).toBe(0)
  })

  it('делит высоту между половинами и оставляет место разделителю', () => {
    const height = 800
    const { top, bottom } = splitHeights(height, 0.5)
    expect(top + bottom).toBe(height - EEG_SPLITTER_H)
    expect(top).toBe(bottom)
    // Холст половины меньше её высоты ровно на полосу таймлайна
    expect(halfCanvasHeight(top)).toBe(top - 20)
  })

  it('зажимает разделитель по минимальным высотам половин', () => {
    const height = 600
    const available = height - EEG_SPLITTER_H
    const minRatio = EEG_MIN_HALF_H / available

    expect(clampSplitRatio(0.01, height)).toBeCloseTo(minRatio, 6)
    expect(clampSplitRatio(0.99, height)).toBeCloseTo(1 - minRatio, 6)
    // На низком окне доля не «дёргается»: зажимать нечем, отношение остаётся
    expect(clampSplitRatio(0.3, 200)).toBeCloseTo(0.3, 6)
    expect(clampSplitRatio(Number.NaN, height)).toBe(0.5)
  })
})

describe('шкала времени области графика', () => {
  it('кладёт край окна на край области, а не на край холста', () => {
    // Полоса времени считала шкалу по всей ширине контейнера — вместе со
    // столбцами подписи и значений; её метки и курсор уезжали от графика
    const window = { t0: 10, t1: 20 }
    expect(plotTimeX(10, window, 1200)).toBe(plotLeftPx())
    expect(plotTimeX(20, window, 1200)).toBe(plotRightPx(1200))
    expect(plotTimeX(15, window, 1200)).toBeCloseTo((plotLeftPx() + plotRightPx(1200)) / 2, 6)
    // Размах окна укладывается ровно в область графика, а не в холст целиком
    expect(plotTimeX(20, window, 1200) - plotTimeX(10, window, 1200)).toBe(plotWidthPx(1200))
  })

  it('переводит клик в время тем же масштабом', () => {
    const window = { t0: 0, t1: 100 }
    expect(plotTimeAtX(plotLeftPx(), window, 1200)).toBe(0)
    expect(plotTimeAtX(plotRightPx(1200), window, 1200)).toBe(100)
    expect(plotTimeAtX(plotLeftPx() + plotWidthPx(1200) / 2, window, 1200)).toBeCloseTo(50, 6)
  })

  it('знает, попадает ли момент в окно', () => {
    const window = { t0: 0, t1: 10 }
    expect(timeInWindow(0, window)).toBe(true)
    expect(timeInWindow(10, window)).toBe(true)
    expect(timeInWindow(10.01, window)).toBe(false)
    expect(timeInWindow(-0.5, window)).toBe(false)
  })
})

describe('рамка видимой части записи', () => {
  it('обводит окно трека внутри показанного окна половины', () => {
    // «Обзор»: спектрограмма показывает всю запись (0–100 с), трек — окно 40–50 с;
    // без рамки не видно, какой отрезок открыт вверху (и куда попадёт клик)
    const shown = { t0: 0, t1: 100 }
    const frame = windowFrame({ t0: 40, t1: 50 }, shown, 1200)
    expect(frame).not.toBeNull()
    expect(frame?.x0).toBeCloseTo(plotTimeX(40, shown, 1200), 6)
    expect(frame?.x1).toBeCloseTo(plotTimeX(50, shown, 1200), 6)
    // Рамка — внутри области графика: у половин одна шкала времени
    expect(frame?.x0).toBeGreaterThan(plotLeftPx())
    expect(frame?.x1).toBeLessThan(plotRightPx(1200))
  })

  it('не рисует рамку, когда трек показывает не меньше половины', () => {
    // «Связано»: окна совпадают — рамку «во весь график» читали бы лишней линией
    const window = { t0: 12.5, t1: 22.5 }
    expect(windowFrame(window, { ...window }, 1200)).toBeNull()
    expect(windowFrame({ t0: -5, t1: 105 }, { t0: 0, t1: 100 }, 1200)).toBeNull()
  })

  it('зажимает рамку по области графика и молчит на пустом окне', () => {
    const shown = { t0: 0, t1: 100 }
    // Запись короче сетки расчёта: окно трека уходит левее показанного отрезка
    const left = windowFrame({ t0: -10, t1: 10 }, shown, 1200)
    expect(left?.x0).toBe(plotLeftPx())
    expect(left?.x1).toBeCloseTo(plotTimeX(10, shown, 1200), 6)
    // Узкая полоса (полпикселя) — не рамка, а линия: обводить нечего
    expect(windowFrame({ t0: 0, t1: (0.5 / plotWidthPx(1200)) * 100 }, shown, 1200)).toBeNull()
    // Показанного окна ещё нет (до раскладки) — рисовать нечего
    expect(windowFrame({ t0: 0, t1: 1 }, { t0: 0, t1: 0 }, 1200)).toBeNull()
  })
})

describe('линейка амплитуды', () => {
  it('идёт от +2 делений (сверху) до −2 (снизу) и кладёт ноль в середину', () => {
    const ticks = ampTicks(50, 200)
    expect(ticks).toHaveLength(AMPLITUDE_DIVISIONS + 1)
    // Порядок — сверху вниз: положительные значения вверху (меньший y)
    expect(ticks[0]?.value).toBe(100)
    expect(ticks[ticks.length - 1]?.value).toBe(-100)
    expect(ticks.find((tick) => tick.value === 0)?.y).toBe(100)
    expect(amplitudeRangeUv(50)).toBe(100)
    const ys = ticks.map((tick) => tick.y)
    expect(ys).toEqual([...ys].sort((a, b) => a - b))
  })

  it('переводит значение в пиксель и обратно', () => {
    expect(valueToY(0, 100, 200)).toBe(100)
    expect(valueToY(100, 100, 200)).toBe(0)
    expect(valueToY(-100, 100, 200)).toBe(200)
    expect(yToValue(100, 100, 200)).toBe(0)
    expect(yToValue(0, 100, 200)).toBe(100)
  })

  it('приводит шкалу к ряду и шагает по нему с зажимом', () => {
    expect(normalizeAmplitudeUv(48)).toBe(50)
    expect(normalizeAmplitudeUv(Number.NaN)).toBe(AMPLITUDE_UV_PER_DIV[2])
    expect(stepAmplitudeUv(50, 1)).toBe(100)
    expect(stepAmplitudeUv(50, -1)).toBe(20)
    const last = AMPLITUDE_UV_PER_DIV[AMPLITUDE_UV_PER_DIV.length - 1] as number
    expect(stepAmplitudeUv(last, 3)).toBe(last)
  })

  it('при перетаскивании вниз деление крупнеет, вверх — мельчает', () => {
    expect(dragAmplitudeUv(50, 30)).toBe(100)
    expect(dragAmplitudeUv(50, -30)).toBe(20)
    // Мелкое движение (< 24 px) шкалу не меняет
    expect(dragAmplitudeUv(50, 10)).toBe(50)
  })

  it('переводит клик по треку в уровень сигнала и подписывает его у линейки', () => {
    // Обратная к `valueToY` по той же шкале: разъехавшиеся формулы поставили бы
    // линию уровня не на ту подпись у линейки мкВ
    expect(yToAmplitudeUv(100, 50, 200)).toBe(0)
    expect(yToAmplitudeUv(0, 50, 200)).toBe(100)
    expect(yToAmplitudeUv(200, 50, 200)).toBe(-100)
    expect(yToAmplitudeUv(100, 20, 200)).toBe(0)
    expect(formatUvLevel(27.4)).toBe('27 мкВ')
    expect(formatUvLevel(-0.2)).toBe('0 мкВ')
  })
})

describe('линейка частот', () => {
  it('ставит 0 Гц вниз, верхнюю частоту — вверх и берёт круглый шаг', () => {
    const ticks = freqTicks(0, 40, 200)
    expect(ticks[0]?.value).toBe(0)
    expect(ticks[0]?.y).toBe(200)
    expect(ticks.map((tick) => tick.value)).toEqual([0, 10, 20, 30, 40])
    expect(ticks[ticks.length - 1]?.y).toBeLessThan(60)
    expect(formatHzTick(7.5)).toBe('7.5')
    expect(formatHzTick(10)).toBe('10')
  })

  it('считает круглый шаг шкалы для любого размаха', () => {
    expect(niceStep(40, 5)).toBe(10)
    expect(niceStep(4, 5)).toBe(1)
    expect(niceStep(1000, 5)).toBe(200)
    expect(niceStep(0, 5)).toBe(1)
  })

  it('перетаскивание линейки расширяет и сужает окно, не выходя за границы', () => {
    const widened = dragFreqWindow([10, 20], 120, 40)
    expect(widened[0]).toBeLessThan(10)
    expect(widened[1]).toBeGreaterThan(20)

    const narrowed = dragFreqWindow([0, 40], -120, 40)
    expect(narrowed[0]).toBeGreaterThanOrEqual(0)
    expect(narrowed[1]).toBeLessThanOrEqual(40)

    // Ширина не схлопывается в ноль: линейка не «выворачивается»
    const tight = dragFreqWindow([10, 11], -1000, 40)
    expect(tight[1] - tight[0]).toBeGreaterThanOrEqual(2)
  })

  it('переводит клик в частоту обратной к рисованию функцией', () => {
    // Маркер частоты рисуется по `fmaxToY`, а считается по `yToFreq`: шкалы обязаны
    // быть обратными, иначе линия встанет не на ту частоту, которую подписала
    expect(yToFreq(fmaxToY(12, 0, 40, 200), 0, 40, 200)).toBeCloseTo(12, 6)
    expect(yToFreq(fmaxToY(0, 0, 40, 200), 0, 40, 200)).toBeCloseTo(0, 6)
    expect(yToFreq(0, 0, 40, 200)).toBe(40)
    expect(yToFreq(200, 0, 40, 200)).toBe(0)
    // Окно нулевой ширины — не частота: возвращаем нижнюю границу, а не NaN
    expect(yToFreq(0, 40, 40, 200)).toBe(40)
  })

  it('лог-шкала: обратна сама себе и не выходит из окна (N18)', () => {
    // Обратность на обеих шкалах — одно правило (обратная функция рядом с прямой)
    for (const value of [1, 2, 5, 10, 20, 39.5]) {
      expect(yToFreq(fmaxToY(value, 0, 40, 200, 'log'), 0, 40, 200, 'log')).toBeCloseTo(value, 6)
    }
    // Границы: 1 Гц — внизу (0 Гц в лог не входит), fmax — наверху
    expect(fmaxToY(1, 0, 40, 200, 'log')).toBeCloseTo(200, 6)
    expect(fmaxToY(40, 0, 40, 200, 'log')).toBeCloseTo(0, 6)
    // Низкая частота прижимается к низу, а не «уезжает» за картинку
    expect(fmaxToY(0.2, 0, 40, 200, 'log')).toBe(200)
  })

  it('лог-линейка берёт деления 1/2/5 × 10^k, а не равный шаг чисел', () => {
    const ticks = freqTicks(1, 40, 200, 5, 'log')
    expect(ticks.map((tick) => tick.value)).toEqual([1, 2, 5, 10, 20])
    // Деления идут сверху вниз по убыванию y: у 1 Гц y больше, чем у 20 Гц
    expect(ticks[0]?.y).toBeGreaterThan(ticks[ticks.length - 1]?.y as number)
  })
})

describe('полоса времени', () => {
  it('ставит деления на круглых секундах окна', () => {
    const ticks = timeTicks(0, 10, 1000)
    expect(ticks[0]?.timeSec).toBe(0)
    expect(ticks[0]?.x).toBe(0)
    expect(ticks[ticks.length - 1]?.timeSec).toBe(10)
    expect(ticks[ticks.length - 1]?.x).toBeCloseTo(1000, 6)
    expect(ticks).toHaveLength(6)
  })

  it('на пустом окне делений нет, а подпись зависит от размаха', () => {
    expect(timeTicks(5, 5, 1000)).toEqual([])
    expect(formatAxisTime(12.345, 100)).toBe('12 с')
    expect(formatAxisTime(1.2345, 2)).toBe('1.23 с')
  })
})

describe('окно времени', () => {
  it('совпадает с окном вьюера EDF: ×2 — половина записи, ×1 — вся', () => {
    expect(eegWindow(100, 1, 50)).toEqual({ t0: 0, t1: 100 })
    expect(eegWindow(100, 2, 50)).toEqual({ t0: 25, t1: 75 })
    // Центр у края зажимается: окно не вылезает за запись
    expect(eegWindow(100, 2, 0)).toEqual({ t0: 0, t1: 50 })
  })
})

