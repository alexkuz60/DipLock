/**
 * Тесты настроек таблицы локализации (срез 4): порядок строк и видимые колонки.
 *
 * Настройки — только состояние просмотра: проверяем, что правка меняет срез и не
 * трогает ничего другого (результат расчёта и параметры расчёта живут отдельно).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultColumnVisibility } from '@/shared/lib/tableRows'
import { CALC_PARAM_DEFAULTS, useDipoleCalc } from '@/shared/state/dipoleCalc'
import { TABLE_PARAM_DEFAULTS, useTableParams } from '@/shared/state/tableParams'
import { dipoleScanResultFixture } from '@/test/fixtures'

function resetTableParams() {
  useTableParams.setState({
    params: { ...TABLE_PARAM_DEFAULTS, columnVisibility: defaultColumnVisibility() },
  })
}

describe('настройки таблицы локализации', () => {
  beforeEach(() => {
    localStorage.clear()
    resetTableParams()
    useDipoleCalc.setState({ params: { ...CALC_PARAM_DEFAULTS }, result: null })
  })

  it('по умолчанию сортирует по возрастанию и показывает все колонки', () => {
    const params = useTableParams.getState().params

    expect(params.sortDirection).toBe('asc')
    expect(Object.values(params.columnVisibility).every(Boolean)).toBe(true)
    expect(Object.keys(params.columnVisibility)).toHaveLength(10)
  })

  it('переключает направление сортировки', () => {
    useTableParams.getState().setSortDirection('desc')

    expect(useTableParams.getState().params.sortDirection).toBe('desc')
  })

  it('скрывает и показывает колонку', () => {
    const store = useTableParams.getState()

    store.setColumnVisible('gof', false)
    expect(useTableParams.getState().params.columnVisibility.gof).toBe(false)

    store.setColumnVisible('gof', true)
    expect(useTableParams.getState().params.columnVisibility.gof).toBe(true)
  })

  it('«Показать все» возвращает колонки, а «сбросить» — ещё и сортировку', () => {
    useTableParams.getState().setColumnVisible('area', false)
    useTableParams.getState().setColumnVisible('z', false)
    useTableParams.getState().setSortDirection('desc')

    useTableParams.getState().showAllColumns()
    expect(Object.values(useTableParams.getState().params.columnVisibility).every(Boolean)).toBe(true)
    // Сортировка — отдельная настройка: «Показать все» её не трогает
    expect(useTableParams.getState().params.sortDirection).toBe('desc')

    useTableParams.getState().reset()
    expect(useTableParams.getState().params).toEqual(TABLE_PARAM_DEFAULTS)
  })

  it('правка настроек таблицы не трогает результат и параметры расчёта', () => {
    // Правило раздела: настройки просмотра ничего не запускают и не сбрасывают
    useDipoleCalc.setState({ result: dipoleScanResultFixture() })

    useTableParams.getState().setColumnVisible('x', false)
    useTableParams.getState().setSortDirection('desc')

    expect(useDipoleCalc.getState().result?.points).toHaveLength(4)
    expect(useDipoleCalc.getState().params).toEqual(CALC_PARAM_DEFAULTS)
  })
})