/**
 * Тесты таблицы локализации (срез 4): строки из результата расчёта диполей.
 *
 * Проверяется главное обещание раздела: в таблице **все** точки результата
 * (включая те, что без MNI), сортировка — по номеру эпохи, а отсутствующие
 * величины показываются прочерком, а не нулём.
 */
import { describe, expect, it } from 'vitest'
import {
  EM_DASH,
  cellText,
  defaultColumnVisibility,
  hiddenColumnCount,
  hemisphereLabel,
  hemisphereOf,
  localizationRows,
  missingMniCount,
  rowTooltip,
  sortDirectionLabel,
  sortRowsByEpoch,
  tableRows,
  visibleColumns,
} from '@/shared/lib/tableRows'
import { dipoleScanResultFixture } from '@/test/fixtures'
import type { DipoleScanPoint } from '@/shared/api/types'

/** Точка результата с нужными для теста полями (остальное — из фикстуры). */
function point(overrides: Partial<DipoleScanPoint> = {}): DipoleScanPoint {
  return {
    epoch_index: 0,
    time_ms: 120,
    head_coords: [0, 0, 0],
    mni_coords: [10, 20, 30],
    moment: [0, 1, 0],
    amplitude_nam: 60,
    gof: 0.91,
    brodmann_area: 'BA17-lh',
    anatomical_structure: 'таламус (слева)',
    ...overrides,
  }
}

describe('строки таблицы локализации', () => {
  it('берёт все точки результата, включая точки без MNI', () => {
    const result = dipoleScanResultFixture()
    const rows = localizationRows(result)

    // В фикстуре 4 точки, одна без MNI: «все результаты» — это все, а не
    // «те, что удалось навести на проекции»
    expect(rows).toHaveLength(result.points.length)
    expect(missingMniCount(rows)).toBe(1)
    expect(rows[3].mni).toBeNull()
    expect(rows[0].mni).toEqual([12, -34.5, 18])
  })

  it('сортирует по номеру эпохи в обе стороны', () => {
    const points = [
      point({ epoch_index: 2, time_ms: 60 }),
      point({ epoch_index: 0, time_ms: 200 }),
      point({ epoch_index: 1, time_ms: 140 }),
    ]
    const result = dipoleScanResultFixture({ points, n_epochs_total: 3, n_epochs_used: 3 })

    expect(tableRows(result, 'asc').map((row) => row.epochIndex)).toEqual([0, 1, 2])
    expect(tableRows(result, 'desc').map((row) => row.epochIndex)).toEqual([2, 1, 0])
  })

  it('строки одной эпохи переворачиваются вместе с таблицей, а не «смешиваются»', () => {
    // Быстрый режим даёт одну точку на эпоху, но контракт допускает несколько:
    // вторичный ключ (время пика) должен идти в ту же сторону, что и основной
    const points = [
      point({ epoch_index: 0, time_ms: 40 }),
      point({ epoch_index: 0, time_ms: 120 }),
    ]
    const rows = localizationRows(dipoleScanResultFixture({ points }))

    expect(sortRowsByEpoch(rows, 'asc').map((row) => row.timeMs)).toEqual([40, 120])
    expect(sortRowsByEpoch(rows, 'desc').map((row) => row.timeMs)).toEqual([120, 40])
    // Исходный массив не мутируется: сортировка — копия
    expect(rows.map((row) => row.timeMs)).toEqual([40, 120])
  })

  it('нумерует эпохи с единицы — как подсказки проекций', () => {
    const rows = localizationRows(dipoleScanResultFixture())

    expect(cellText(rows[0], 'epoch')).toBe('1')
    expect(cellText(rows[3], 'epoch')).toBe('4')
    expect(rowTooltip(rows[0])).toContain('Эпоха 1, пик 0.120 с')
  })

  it('форматирует величины, а отсутствующие показывает прочерком', () => {
    const rows = localizationRows(dipoleScanResultFixture())
    const noMni = rows[3]

    expect(cellText(rows[0], 'x')).toBe('12.0')
    expect(cellText(rows[0], 'y')).toBe('-34.5')
    expect(cellText(rows[0], 'time')).toBe('0.120')
    expect(cellText(rows[0], 'amplitude')).toBe('60.0')
    expect(cellText(rows[0], 'gof')).toBe('91.0')
    expect(cellText(rows[0], 'area')).toBe('BA17-lh')

    // Точка без MNI: ни нулей, ни пустых ячеек — честный прочерк
    expect(cellText(noMni, 'x')).toBe(EM_DASH)
    expect(cellText(noMni, 'hemisphere')).toBe(EM_DASH)
    expect(rowTooltip(noMni)).toContain('MNI нет (fsaverage недоступен)')
  })

  it('прочерк и для нечисловых значений — NaN не должен выглядеть как ноль', () => {
    const rows = localizationRows(
      dipoleScanResultFixture({
        points: [point({ amplitude_nam: Number.NaN, gof: Number.NaN, brodmann_area: null, mni_coords: [Number.NaN, 1, 2] })],
      }),
    )

    expect(cellText(rows[0], 'amplitude')).toBe(EM_DASH)
    expect(cellText(rows[0], 'gof')).toBe(EM_DASH)
    expect(cellText(rows[0], 'x')).toBe(EM_DASH)
    expect(cellText(rows[0], 'area')).toBe(EM_DASH)
    expect(rows[0].mni).toBeNull()
  })

  it('выводит полушарие из знака MNI x (RAS: x > 0 — правое)', () => {
    expect(hemisphereOf(12)).toBe('right')
    expect(hemisphereOf(-12)).toBe('left')
    expect(hemisphereOf(0)).toBe('midline')
    expect(hemisphereOf(null)).toBeNull()
    expect(hemisphereLabel('right')).toBe('правое (R)')
    expect(hemisphereLabel('left')).toBe('левое (L)')
    expect(hemisphereLabel(null)).toBe(EM_DASH)
  })

  it('держит состав колонок и их видимость', () => {
    const visibility = defaultColumnVisibility()
    expect(visibleColumns(visibility).map((column) => column.key)).toEqual([
      'epoch',
      'time',
      'x',
      'y',
      'z',
      'amplitude',
      'gof',
      'hemisphere',
      'structure',
      'area',
    ])
    expect(hiddenColumnCount(visibility)).toBe(0)

    const hidden = { ...visibility, gof: false }
    expect(hiddenColumnCount(hidden)).toBe(1)
    expect(visibleColumns(hidden).map((column) => column.key)).not.toContain('gof')
    // Порядок колонок остаётся табличным, а не «порядком выключения»
    expect(visibleColumns(hidden)[0].key).toBe('epoch')
  })

  it('называет направление сортировки словами', () => {
    expect(sortDirectionLabel('asc')).toBe('по номеру эпохи (возрастание)')
    expect(sortDirectionLabel('desc')).toBe('по номеру эпохи (убывание)')
  })
})