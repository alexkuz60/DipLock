/**
 * Тесты часов воспроизведения (срез 3.7).
 *
 * Часы — единственное место с непрерывным временем: они идут по `requestAnimationFrame`,
 * считают эпоху по сетке нарезки и переносят кадр на измеренную точку, когда
 * воспроизведение стоит. Поэтому `rAF` здесь подменён **управляемым** кадровым
 * циклом: время в тесте идёт ровно по 16 мс, и проверки не зависят от внутренностей
 * подменённых таймеров.
 */
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PLAYBACK_DEFAULTS, useDipoleCalc } from '@/shared/state/dipoleCalc'
import { dipoleScanResultFixture } from '@/test/fixtures'
import { PlaybackFrameProvider } from './PlaybackFrame'
import { usePlaybackFrame } from './playbackClock'

/** Проба: показывает то, что видит проекция — время, долю и точку кадра. */
function Probe() {
  const frame = usePlaybackFrame()
  if (!frame) return <span data-testid="frame">нет кадра</span>
  return (
    <span data-testid="frame">
      {`${Math.round(frame.timeMs)}|${frame.fraction.toFixed(3)}|${frame.point?.id ?? '—'}`}
    </span>
  )
}

function renderClock() {
  return render(
    <PlaybackFrameProvider>
      <Probe />
    </PlaybackFrameProvider>,
  )
}

function frameText(): string {
  return screen.getByTestId('frame').textContent ?? ''
}

/** Результат фикстуры: нарезка 1000 мс, 4 эпохи, точки у эпох 0…2 (у 3-й нет MNI) */
function setResult(options: { playing?: boolean; speed?: 1 | 2 | 4; epochIndex?: number } = {}) {
  useDipoleCalc.setState({
    result: dipoleScanResultFixture(),
    playback: {
      ...PLAYBACK_DEFAULTS,
      active: true,
      playing: options.playing ?? false,
      speed: options.speed ?? 1,
      epochIndex: options.epochIndex ?? 0,
    },
  })
}

describe('часы воспроизведения траектории', () => {
  let pending: Map<number, FrameRequestCallback>
  let nextId: number
  let clockMs: number

  beforeEach(() => {
    localStorage.clear()
    useDipoleCalc.setState({ result: null, playback: { ...PLAYBACK_DEFAULTS } })
    pending = new Map()
    nextId = 1
    clockMs = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextId++
      pending.set(id, callback)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      pending.delete(id)
    })
  })

  /** Прокручивает кадры по 16 мс: `ms` — сколько миллисекунд времени прошло */
  function advance(ms: number) {
    act(() => {
      for (let elapsed = 0; elapsed < ms; elapsed += 16) {
        clockMs += 16
        const callbacks = [...pending.values()]
        pending.clear()
        for (const callback of callbacks) callback(clockMs)
      }
    })
  }

  it('стоит на измеренной точке своей эпохи, пока воспроизведение на паузе', () => {
    setResult({ epochIndex: 1 })
    renderClock()

    // Доля нулевая: на паузе кадр — измерение, а не «полутон» между эпохами
    expect(frameText()).toBe('1000|0.000|1-140')
  })

  it('ведёт кадр вперёд и переключает эпохи по сетке нарезки', () => {
    setResult({ playing: true })
    renderClock()

    advance(500)
    expect(useDipoleCalc.getState().playback.epochIndex).toBe(0)
    const [, fraction] = frameText().split('|')
    expect(Number(fraction)).toBeGreaterThan(0.4)
    expect(Number(fraction)).toBeLessThan(0.6)

    advance(600)
    // 1100 мс: вторая эпоха (нарезка 1000 мс)
    expect(useDipoleCalc.getState().playback.epochIndex).toBe(1)
    expect(frameText().startsWith('1')).toBe(true)
  })

  it('ускоряется: ×2 проходит вдвое больше эпох за то же время', () => {
    setResult({ playing: true, speed: 2 })
    renderClock()

    advance(1500)

    // 1500 мс реального времени ×2 = 3000 мс записи → третья эпоха
    expect(useDipoleCalc.getState().playback.epochIndex).toBe(2)
  })

  it('останавливается в конце записи, вставая на последнюю эпоху', () => {
    setResult({ playing: true })
    renderClock()

    // Нарезка 4 × 1000 мс: кадров больше нет, воспроизведение выключается
    advance(5000)

    expect(useDipoleCalc.getState().playback).toMatchObject({
      playing: false,
      epochIndex: 3,
    })
    expect(frameText()).toBe('3000|0.000|—')
  })

  it('переносит кадр по команде «покадрово» и ставится на паузу', () => {
    setResult({ playing: true })
    renderClock()

    advance(500)
    act(() => {
      useDipoleCalc.getState().stepPlaybackEpoch(2)
    })

    // Часы увидели команду (`seekSeq`) и встали на начало новой эпохи
    expect(useDipoleCalc.getState().playback).toMatchObject({ playing: false, epochIndex: 2 })
    expect(frameText()).toBe('2000|0.000|2-60')
  })

  it('останавливается при уходе из раздела: часы живут только в нём', () => {
    setResult({ playing: true })
    const view = renderClock()
    advance(500)
    expect(useDipoleCalc.getState().playback.playing).toBe(true)

    view.unmount()

    expect(useDipoleCalc.getState().playback.playing).toBe(false)
    // Кадр остаётся: ушли из раздела — не значит «забыли, где остановились»
    expect(useDipoleCalc.getState().playback.active).toBe(true)
  })

  it('делает кадр пустым, пока он не задействован, и в эпохах без диполя', () => {
    setResult({ playing: false, epochIndex: 3 })
    useDipoleCalc.setState({ playback: { ...PLAYBACK_DEFAULTS } })
    renderClock()

    // Кадр не задействован — проекции показывают обычное облако
    expect(frameText()).toBe('0|0.000|—')
  })

  it('скрывает слабый кадр порогом «КД», не останавливая воспроизведение', () => {
    setResult({ playing: true })
    useDipoleCalc.setState({ amplitudeThresholdNam: 100 })
    renderClock()

    advance(500)

    // Порог — правило отображения: кадр не рисуется, но время идёт
    expect(frameText().endsWith('|—')).toBe(true)
    expect(useDipoleCalc.getState().playback.playing).toBe(true)
  })

  it('не перерисовывает статичные слои на каждом кадре: кадр идёт контекстом', () => {
    // Проекции приходят провайдеру как `children` (теми же элементами), поэтому
    // 60 кадров в секунду обновляют только маркер кадра, а срез, поля и облако из
    // сотен точек React не трогает — иначе анимация на реальной записи съедала бы CPU
    let renders = 0
    function Counter() {
      renders += 1
      return <span data-testid="counter" />
    }

    setResult({ playing: true })
    render(
      <PlaybackFrameProvider>
        <Counter />
      </PlaybackFrameProvider>,
    )
    const before = renders

    advance(500)

    // Время шло (кадры обрабатывались), а статичный сосед рисовался только раз
    expect(useDipoleCalc.getState().playback.playing).toBe(true)
    expect(renders).toBe(before)
  })
})
