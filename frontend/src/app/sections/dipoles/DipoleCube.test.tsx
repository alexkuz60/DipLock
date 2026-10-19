/**
 * Тесты 3D-вида «Куб» (`DipoleCube.tsx`): канвас со срезами на стенках, режимы
 * стенок (срезы/силуэт и авто-правило), выбор точки кликом и реакция на ракурс.
 *
 * В jsdom нет WebGL и ResizeObserver, поэтому подменяются оба: наблюдатель
 * сразу сообщает размер канваса, а 2D-контекст — фейковый журнал вызовов (по
 * образцу `waveformView.test.ts`): проверяются **наши** вызовы рисования, а не
 * пиксели. Картинки стенок в jsdom не грузятся — отрисовка идёт без них.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { CUBE_DEFAULT_VIEW, cubeProjector } from '@/shared/lib/dipoleCube'
import type { DipoleLayer, DipolePoint } from '@/shared/lib/dipolePoints'
import { defaultSlices, type MniVector } from '@/shared/lib/mriProjections'
import type { MriSliceRef } from '@/shared/api/types'
import { DipoleCube } from './DipoleCube'
import { PlaybackFrameContext, type PlaybackFrame } from './playbackClock'

const SIZE = { width: 600, height: 500 }

/** Журнал вызовов фейкового 2D-контекста. */
type CtxLog = { calls: string[] }

let log: CtxLog = { calls: [] }

function fakeContext(): CanvasRenderingContext2D {
  const ctx: Record<string, unknown> = {}
  for (const method of [
    'setTransform',
    'clearRect',
    'fillRect',
    'beginPath',
    'moveTo',
    'lineTo',
    'closePath',
    'fill',
    'stroke',
    'arc',
    'drawImage',
    'save',
    'restore',
    'fillText',
  ]) {
    ctx[method] = (...args: unknown[]) => {
      log.calls.push(`${method}(${args.length})`)
    }
  }
  for (const prop of ['fillStyle', 'strokeStyle', 'lineWidth', 'globalAlpha', 'font']) {
    Object.defineProperty(ctx, prop, { value: '', writable: true })
  }
  return ctx as unknown as CanvasRenderingContext2D
}

const MRI_REF: MriSliceRef = {
  version: 'v12345678',
  slice_url: '/api/v1/surface/mri/slice',
  mip_url: '/api/v1/surface/mri/mip',
  spacing_mm: 1,
}

function point(id: string, position: MniVector, epochIndex = 0): DipolePoint {
  return {
    id,
    epochIndex,
    timeMs: 100,
    position,
    orientation: { x: 0, y: 0, z: 1 },
    amplitudeNaM: 12,
    gof: 0.9,
    brodmannArea: null,
    structure: null,
    structureDistanceMm: null,
    areaDistanceMm: null,
    outsideBrain: null,
  }
}

const POINT_A = point('1-100', { x: -42, y: -18, z: 16 })
const POINT_B = point('2-200', { x: 40, y: 10, z: -10 }, 1)

const LAYER: DipoleLayer = { points: [POINT_A, POINT_B], source: 'result' }

const VISIBILITY = {
  mri: true,
  anatomy: true,
  brain: true,
  mni: true,
  brodmann: true,
  dipoles: true,
  vectors: true,
  spiral: true,
  playback: true,
}

function renderCube(
  props: Partial<ComponentProps<typeof DipoleCube>> = {},
  frame: PlaybackFrame | null = null,
) {
  const onPickPoint = vi.fn()
  const ui = (
    <DipoleCube
      mri={MRI_REF}
      slices={defaultSlices()}
      visibility={VISIBILITY}
      layer={LAYER}
      focus={[]}
      cursor={null}
      onPickPoint={onPickPoint}
      dimmed={false}
      {...props}
    />
  )
  render(
    frame ? (
      <PlaybackFrameContext.Provider value={frame}>{ui}</PlaybackFrameContext.Provider>
    ) : (
      ui
    ),
  )
  return { onPickPoint }
}

/** Точка в экранных пикселях куба (стартовый ракурс, размер канваса из мока). */
function projectedOf(target: MniVector): { x: number; y: number } {
  return cubeProjector(CUBE_DEFAULT_VIEW, SIZE).project(target)
}

/**
 * Pointer-событие с координатами: jsdom без PointerEvent, поэтому шлём нативный
 * `MouseEvent` с типом pointer-события (в нём есть clientX) — паттерн
 * `NeuromusicSection.test.tsx`.
 */
function firePointer(canvas: Element, type: string, x: number, y: number): void {
  fireEvent(canvas, new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y }))
}

class FakeResizeObserver {
  constructor(private readonly callback: (entries: unknown[]) => void) {}
  observe(): void {
    this.callback([{ contentRect: { width: SIZE.width, height: SIZE.height } }])
  }
  disconnect(): void {}
}

describe('3D-вид «Куб»', () => {
  beforeEach(() => {
    log = { calls: [] }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(fakeContext as never)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('рисует канвас и шапку; режимов Niivue «Мультисрез»/«3D-рендер» больше нет', () => {
    renderCube()
    expect(screen.getByTestId('dipole-cube-canvas')).toBeInTheDocument()
    expect(screen.getByText('Стенки: срезы MNI')).toBeInTheDocument()
    expect(screen.getByText('Диполей в 3D: 2')).toBeInTheDocument()
    expect(screen.queryByText('Мультисрез')).not.toBeInTheDocument()
    expect(screen.queryByText('3D-рендер')).not.toBeInTheDocument()
    // Стенки получают картинки: три прямоугольника заливаются и обводятся
    expect(log.calls.filter((call) => call.startsWith('fillRect(')).length).toBeGreaterThanOrEqual(1)
  })

  it('пакет из нескольких точек переводит стенки в силуэт (авто-правило)', () => {
    renderCube({ focus: [POINT_A, POINT_B] })
    expect(screen.getByText('Стенки: силуэт мозга')).toBeInTheDocument()
  })

  it('одна точка в фокусе держит срезы; ручной выбор «Стенки» переопределяет авто', async () => {
    const user = userEvent.setup()
    renderCube({ focus: [POINT_A] })
    expect(screen.getByText('Стенки: срезы MNI')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Силуэт' }))
    expect(screen.getByText('Стенки: силуэт мозга')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Срезы' }))
    expect(screen.getByText('Стенки: срезы MNI')).toBeInTheDocument()
  })

  it('ручные «Срезы» сильнее авто-правила даже для пакета из двух точек', async () => {
    const user = userEvent.setup()
    renderCube({ focus: [POINT_A, POINT_B] })
    expect(screen.getByText('Стенки: силуэт мозга')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Срезы' }))
    expect(screen.getByText('Стенки: срезы MNI')).toBeInTheDocument()
  })

  it('клик по точке выбирает диполь, мимо точек — снимает выделение', () => {
    const { onPickPoint } = renderCube()
    const canvas = screen.getByTestId('dipole-cube-canvas')
    const target = projectedOf(POINT_A.position)
    firePointer(canvas, 'pointerdown', target.x, target.y)
    firePointer(canvas, 'pointerup', target.x, target.y)
    expect(onPickPoint).toHaveBeenLastCalledWith(POINT_A)
    firePointer(canvas, 'pointerdown', 1, 1)
    firePointer(canvas, 'pointerup', 1, 1)
    expect(onPickPoint).toHaveBeenLastCalledWith(null)
  })

  it('перетаскивание меняет ракурс, «Сбросить ракурс» возвращает стартовый', () => {
    renderCube()
    const root = screen.getByTestId('dipole-cube')
    const canvas = screen.getByTestId('dipole-cube-canvas')
    expect(root).toHaveAttribute('data-azimuth', '45')
    firePointer(canvas, 'pointerdown', 300, 250)
    firePointer(canvas, 'pointermove', 350, 250)
    firePointer(canvas, 'pointerup', 350, 250)
    expect(root).toHaveAttribute('data-azimuth', '70')
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить ракурс' }))
    expect(root).toHaveAttribute('data-azimuth', '45')
  })

  it('анимация нескольких полос рисует маркеры и переводит стенки в силуэт', () => {
    const frame: PlaybackFrame = {
      timeMs: 0,
      fraction: 0.5,
      frames: [
        {
          band: { key: 'alpha', label: 'α', bandHz: [8, 12], color: 'hsl(110, 85%, 55%)' },
          point: POINT_A,
          anchor: POINT_A,
          trail: [
            {
              id: 't1',
              from: { x: -40, y: -10, z: 10 },
              to: { x: -42, y: -18, z: 16 },
              alpha: 0.4,
            },
          ],
          headSegment: null,
        },
        {
          band: { key: 'beta', label: 'β', bandHz: [13, 30], color: 'hsl(165, 85%, 55%)' },
          point: POINT_B,
          anchor: POINT_B,
          trail: [],
          headSegment: null,
        },
      ],
    }
    renderCube({}, frame)
    expect(screen.getByText('Стенки: силуэт мозга')).toBeInTheDocument()
    // Две точки облака + гало и маркер каждой полосы — кружков не меньше шести
    expect(log.calls.filter((call) => call.startsWith('arc(')).length).toBeGreaterThanOrEqual(6)
    // Шлейф кадра рисуется линиями (stroke), а не только точками
    expect(log.calls.filter((call) => call.startsWith('stroke(')).length).toBeGreaterThan(0)
  })

  it('без ссылок на ассеты честно предупреждает и рисует куб', () => {
    renderCube({ mri: null })
    expect(screen.getByText(/Срезы недоступны/)).toBeInTheDocument()
    expect(screen.getByTestId('dipole-cube-canvas')).toBeInTheDocument()
  })
})

