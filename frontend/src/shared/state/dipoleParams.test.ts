/**
 * Тесты состояния раздела «Диполи» (срез 3.1): слои, срезы, точка, сбросы.
 *
 * Проверяется контракт стора, на который опираются проекции и панель: правка
 * параметров ничего не запускает, срез наводится линейкой или точкой клика,
 * а персистится только набор предпочтений просмотра (не референс-точка сессии).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { applyPointToSlices, defaultSlices } from '@/shared/lib/mriProjections'
import {
  DIPOLE_LAYER_LABELS,
  DIPOLE_PARAM_DEFAULTS,
  EMPTY_SELECTION,
  currentSlices,
  layerVisible,
  sliceTitleOf,
  useDipoleParams,
} from './dipoleParams'

/** Приведение стора к значениям по умолчанию: тесты не зависят друг от друга. */
function resetState() {
  useDipoleParams.setState({
    params: { ...DIPOLE_PARAM_DEFAULTS, slices: defaultSlices() },
    selection: EMPTY_SELECTION,
  })
}

describe('состояние раздела «Диполи»', () => {
  beforeEach(() => {
    localStorage.clear()
    resetState()
  })

  it('включает и выключает фоновые слои', () => {
    const state = useDipoleParams.getState()
    expect(layerVisible(state.params.layerVisibility, 'brodmann')).toBe(true)

    state.setLayerVisible('brodmann', false)
    expect(useDipoleParams.getState().params.layerVisibility.brodmann).toBe(false)

    useDipoleParams.getState().toggleLayer('brodmann')
    expect(useDipoleParams.getState().params.layerVisibility.brodmann).toBe(true)
  })

  it('наводит срез по значению и снимает устаревшую точку', () => {
    useDipoleParams.getState().selectPoint({ x: 0, y: 12, z: 0 }, 'BA4', { sagittal: 'midline' })

    useDipoleParams.getState().setSlice('sagittal', 24)

    const state = useDipoleParams.getState()
    expect(state.params.slices.sagittal).toBe(24)
    // Точка указывала на прежний срез — она снимается, а выделенное поле остаётся
    expect(state.selection.point).toBeNull()
    expect(state.selection.orientations).toEqual({})
    expect(state.selection.area).toBe('BA4')
  })

  it('наводит все три среза точкой клика (через геометрию проекций)', () => {
    const point = { x: 0, y: 30, z: 0 }
    const { orientations } = applyPointToSlices(point)

    useDipoleParams.getState().selectPoint(point, null, orientations)

    const state = useDipoleParams.getState()
    expect(state.params.slices).toEqual({ axial: 0, sagittal: 0, coronal: 30 })
    expect(state.selection.point).toEqual(point)
    expect(state.selection.orientations.sagittal).toBe('midline')
  })

  it('сбрасывает срезы с точкой и возвращает всё по умолчанию', () => {
    useDipoleParams.getState().setSlice('axial', 40)
    useDipoleParams.getState().setLayerVisible('head', false)
    useDipoleParams.getState().selectPoint({ x: 0, y: 0, z: 40 }, 'BA6', {})

    useDipoleParams.getState().resetSlices()
    expect(useDipoleParams.getState().params.slices).toEqual(defaultSlices())
    expect(useDipoleParams.getState().selection).toEqual(EMPTY_SELECTION)
    // Слои — предпочтения просмотра, сброс срезов их не трогает
    expect(useDipoleParams.getState().params.layerVisibility.head).toBe(false)

    useDipoleParams.getState().resetAll()
    expect(useDipoleParams.getState().params.layerVisibility).toEqual(
      DIPOLE_PARAM_DEFAULTS.layerVisibility,
    )
  })

  it('персистит параметры просмотра, но не референс-точку сессии', () => {
    useDipoleParams.getState().setLayerVisible('dipoles', false)
    useDipoleParams.getState().setSlice('coronal', 18)

    const raw = localStorage.getItem('diplock.dipoles')
    expect(raw).toBeTruthy()
    const stored = JSON.parse(raw ?? '{}') as {
      state: {
        params: { layerVisibility: Record<string, boolean>; slices: unknown }
        selection?: unknown
      }
    }

    expect(stored.state.params.layerVisibility.dipoles).toBe(false)
    expect(stored.state.selection).toBeUndefined()
  })

  it('отдаёт подписи срезов и слоёв для проекций и панели', () => {
    useDipoleParams.getState().setSlice('axial', 12)

    const state = useDipoleParams.getState()
    expect(sliceTitleOf(state, 'axial')).toBe('z = 12.0 мм')
    expect(currentSlices(state)).toEqual(state.params.slices)
    expect(DIPOLE_LAYER_LABELS.dipoles).toBe('Точки диполей')
  })
})
