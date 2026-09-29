/**
 * Тесты 3D-вида (срез 3.5): инициализация Niivue с URL из `/meta`, узлы
 * диполей и совместный курсор.
 *
 * В jsdom нет WebGL, поэтому модуль `@niivue/niivue` мокается целиком:
 * тесты проверяют **наши** вызовы (какие URL, какие узлы, куда идут события),
 * а не рендер Niivue — тот проверяется только на живом сервере.
 */
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Вызовы Niivue, которые компонент обязан сделать (перехват мока). */
const niivueCalls = {
  loadVolumes: [] as unknown[],
  loadConnectome: [] as unknown[],
  setSliceType: [] as unknown[],
  attached: [] as unknown[],
}

vi.mock('@niivue/niivue', () => {
  class MockNiivue {
    scene: { crosshairPos: unknown } = { crosshairPos: null }
    onLocationChange: (location: unknown) => void = () => undefined
    constructor() {
      // Последний инстанс — чтобы тест мог вызвать onLocationChange «от Niivue»
      ;(globalThis as Record<string, unknown>).__lastNiivueInstance = this
    }
    attachToCanvas(canvas: unknown) {
      niivueCalls.attached.push(canvas)
    }
    loadVolumes(volumeList: unknown) {
      niivueCalls.loadVolumes.push(volumeList)
      return Promise.resolve(this)
    }
    loadConnectome(connectome: unknown) {
      niivueCalls.loadConnectome.push(connectome)
      return this
    }
    setSliceType(sliceType: unknown) {
      niivueCalls.setSliceType.push(sliceType)
      return this
    }
    drawScene() {
      return undefined
    }
    mm2frac(mm: number[]) {
      return [mm[0] / 256, mm[1] / 256, mm[2] / 256]
    }
  }
  return {
    Niivue: MockNiivue,
    SLICE_TYPE: { AXIAL: 0, CORONAL: 1, SAGITTAL: 2, MULTIPLANAR: 3, RENDER: 4 },
  }
})

import { Brain3D } from './Brain3D'
import type { MriVolumeRef } from '@/shared/api/types'
import type { DipoleLayer } from '@/shared/lib/dipolePoints'

const REF: MriVolumeRef = {
  version: 'vol12345678',
  url: '/api/v1/surface/mri/volume',
  names: ['T1.mgz', 'seghead.mgz', 'lh.white', 'rh.white'],
  affine: [
    [-1, 0, 0, 128],
    [0, 0, 1, -128],
    [0, -1, 0, 128],
    [0, 0, 0, 1],
  ],
}

const LAYER: DipoleLayer = {
  source: 'result',
  points: [
    {
      id: '1-100',
      epochIndex: 0,
      timeMs: 100,
      position: { x: -42, y: -18, z: 16 },
      orientation: { x: 0, y: 0, z: 1 },
      amplitudeNaM: 12,
      gof: 0.9,
      brodmannArea: null,
      structure: null,
      structureDistanceMm: null,
      areaDistanceMm: null,
      outsideBrain: null,
    },
  ],
}

function render3d(props: Partial<React.ComponentProps<typeof Brain3D>> = {}) {
  return render(
    <Brain3D
      volumes={REF}
      layer={LAYER}
      cursor={null}
      onCursor={() => undefined}
      {...props}
    />,
  )
}

beforeEach(() => {
  niivueCalls.loadVolumes.length = 0
  niivueCalls.loadConnectome.length = 0
  niivueCalls.setSliceType.length = 0
  niivueCalls.attached.length = 0
})

afterEach(cleanup)

describe('Brain3D: 3D-вид Niivue', () => {
  it('загружает том T1 по URL из /meta (с ?v= отпечатка)', async () => {
    render3d()
    expect(await screen.findByTestId('brain3d-canvas')).toBeInTheDocument()
    expect(niivueCalls.attached).toHaveLength(1)
    expect(niivueCalls.loadVolumes).toHaveLength(1)
    const [volumeList] = niivueCalls.loadVolumes as [{ url: string; name: string }[]]
    expect(volumeList[0].url).toBe('/api/v1/surface/mri/volume/T1.mgz?v=vol12345678')
    expect(volumeList[0].name).toBe('T1.mgz')
  })

  it('передаёт точки диполя как узлы connectome в мировых мм тома', async () => {
    render3d()
    await screen.findByTestId('brain3d-canvas')
    expect(niivueCalls.loadConnectome).toHaveLength(1)
    const connectome = (niivueCalls.loadConnectome[0] ?? {}) as unknown as {
      nodes: { x: number; y: number; z: number }[]
    }
    // Ожидаемый affine: мировые мм = мм MNI (инвариант talairach)
    expect(connectome.nodes).toHaveLength(1)
    expect(connectome.nodes[0]).toMatchObject({ x: -42, y: -18, z: 16 })
  })

  it('переключает режим Niivue (мультисрез / 3D-рендер)', async () => {
    const user = userEvent.setup()
    render3d()
    await screen.findByTestId('brain3d-canvas')
    // Дефолт — 3D-рендер
    expect(niivueCalls.setSliceType.at(-1)).toBe(4)

    await user.click(screen.getByTestId('brain3d-mode-multiplanar'))
    expect(niivueCalls.setSliceType.at(-1)).toBe(3)

    await user.click(screen.getByTestId('brain3d-mode-render'))
    expect(niivueCalls.setSliceType.at(-1)).toBe(4)
  })

  it('кроссхейр Niivue → курсор проекций; петля гасится допуском', async () => {
    const onCursor = vi.fn()
    render3d({ onCursor })
    await screen.findByTestId('brain3d-canvas')

    // Найти обработчик можно только через экземпляр — мок шлёт событие само:
    // прогоним onLocationChange напрямую через перехваченный инстанс нельзя
    // (компонент его держит в ref), поэтому проверяем через делегат мока:
    // компонент назначает onLocationChange один раз после attach.
    const instance = lastNiivueInstance()
    expect(instance).not.toBeNull()
    instance.onLocationChange({ mm: [10, -20, 30, 1] })
    expect(onCursor).toHaveBeenCalledWith({ x: 10, y: -20, z: 30 })
  })

  it('без ссылки на тома — вид не рисует canvas, а объясняет причину', () => {
    render3d({ volumes: null })
    expect(screen.queryByTestId('brain3d-canvas')).not.toBeInTheDocument()
    expect(screen.getByTestId('brain3d-unavailable')).toBeInTheDocument()
  })
})

/** Последний созданный мок-экземпляр Niivue (компонент держит его в ref). */
function lastNiivueInstance(): { onLocationChange: (location: unknown) => void } {
  return (globalThis as Record<string, unknown>).__lastNiivueInstance as never
}
