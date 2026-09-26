/**
 * Тесты строки анатомии кадра воспроизведения (срез 3.7).
 *
 * Проверяют обещание строки: она называет структуру и поле **той эпохи, на которой
 * стоит кадр**, показывает ближайшую смену только в непрерывной цепочке эпох и
 * молчит там, где данных нет (эпоха без диполя с MNI, кадр скрыт порогом «КД»).
 * Ни одного запроса: анатомию сервер посчитал в результате, а строка лишь её читает.
 */
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DipoleScanPoint } from '@/shared/api/types'
import { PLAYBACK_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { DIPOLE_PARAM_DEFAULTS, useDipoleParams } from '@/shared/state/dipoleParams'
import { dipoleScanResultFixture } from '@/test/fixtures'
import { PlaybackAnatomyLine } from './PlaybackAnatomyLine'

/** Точка результата: метки по умолчанию одни и те же — их и меняют тесты. */
function scanPoint(epochIndex: number, overrides: Partial<DipoleScanPoint> = {}): DipoleScanPoint {
  return {
    epoch_index: epochIndex,
    time_ms: epochIndex * 1000 + 100,
    head_coords: [12, -34.5, 18],
    mni_coords: [12, -34.5, 18],
    moment: [0, 1, 0],
    amplitude_nam: 60,
    gof: 0.91,
    riv: 0.12,
    ci_mm: 7.0,
    brodmann_area: 'BA17-lh',
    anatomical_structure: 'таламус (слева)',
    structure_distance_mm: 0.4,
    brodmann_distance_mm: 0.6,
    outside_brain: false,
    ...overrides,
  }
}

/** Рендерит строку на состоянии раздела: результат, порог «КД» и положение кадра. */
function renderLine(
  options: {
    epochIndex?: number
    threshold?: number
    active?: boolean
    playing?: boolean
    points?: DipoleScanPoint[]
  } = {},
) {
  const points = options.points ?? [scanPoint(0), scanPoint(1)]
  useDipoleCalc.setState({
    result: dipoleScanResultFixture({
      points,
      n_epochs_total: points.length,
      n_epochs_used: points.length,
    }),
    amplitudeThresholdNam: options.threshold ?? 0,
    playback: {
      ...PLAYBACK_DEFAULTS,
      active: options.active ?? true,
      playing: options.playing ?? false,
      epochIndex: options.epochIndex ?? 0,
    },
  })
  return render(<PlaybackAnatomyLine />)
}

/** Строка с подписью анатомии измеренной точки: по ней ищется элемент строки. */
function anatomyLine(): HTMLElement {
  return screen.getByTitle(/Анатомия — метки измеренной точки/)
}

describe('строка анатомии кадра воспроизведения', () => {
  beforeEach(() => {
    localStorage.clear()
    useDipoleCalc.setState({
      result: null,
      amplitudeThresholdNam: 0,
      playback: { ...PLAYBACK_DEFAULTS },
    })
    useDipoleParams.setState({ params: { ...DIPOLE_PARAM_DEFAULTS } })
  })

  it('называет структуру и поле эпохи кадра из результата', () => {
    renderLine({ epochIndex: 0 })

    expect(anatomyLine()).toHaveTextContent('Кадр: эпоха 1 — таламус (слева), BA17-lh')
  })

  it('держит локацию и переход одной строкой: текст читается как одна фраза', () => {
    renderLine({
      epochIndex: 0,
      points: [
        scanPoint(0),
        scanPoint(1),
        scanPoint(2, {
          anatomical_structure: 'прецентральная извилина (слева)',
          brodmann_area: 'BA4-lh',
        }),
      ],
    })

    const text = anatomyLine().textContent ?? ''
    expect(text).toBe(
      'Кадр: эпоха 1 — таламус (слева), BA17-lh · дальше: эпоха 3 (2.100 с) → ' +
        'прецентральная извилина (слева), BA4-lh',
    )
    // Одной строкой: перевода строки в разметке нет — подпись читается одной фразой
    expect(text).not.toContain('\n')
  })

  it('следует за кадром: перевод на другую эпоху меняет подпись', () => {
    renderLine({
      epochIndex: 0,
      points: [
        scanPoint(0),
        scanPoint(1, {
          anatomical_structure: 'прецентральная извилина (слева)',
          brodmann_area: 'BA4-lh',
        }),
      ],
    })
    expect(anatomyLine()).toHaveTextContent('Кадр: эпоха 1 — таламус (слева), BA17-lh')

    act(() => {
      useDipoleCalc.getState().seekPlaybackEpoch(1)
    })

    expect(anatomyLine()).toHaveTextContent(
      'Кадр: эпоха 2 — прецентральная извилина (слева), BA4-lh',
    )
  })

  it('показывает ближайшую смену анатомии в непрерывной цепочке эпох', () => {
    renderLine({
      epochIndex: 0,
      points: [
        scanPoint(0),
        scanPoint(1),
        scanPoint(2, {
          anatomical_structure: 'прецентральная извилина (слева)',
          brodmann_area: 'BA4-lh',
        }),
      ],
    })

    // «Дальше» — это следующая **измеренная** метка, а не предсказание положения
    expect(anatomyLine()).toHaveTextContent(
      'дальше: эпоха 3 (2.100 с) → прецентральная извилина (слева), BA4-lh',
    )
  })

  it('не показывает смену через разрыв в данных: это разрыв, а не переход', () => {
    renderLine({
      epochIndex: 0,
      points: [
        scanPoint(0),
        scanPoint(2, { anatomical_structure: 'прецентральная извилина (слева)' }),
      ],
    })

    expect(anatomyLine()).toHaveTextContent('Кадр: эпоха 1 — таламус (слева), BA17-lh')
    expect(anatomyLine()).not.toHaveTextContent('дальше')
  })

  it('пишет «анатомия не определена» вместо служебного «unknown»', () => {
    renderLine({
      epochIndex: 0,
      points: [scanPoint(0, { brodmann_area: 'unknown', anatomical_structure: 'unknown' })],
    })

    expect(anatomyLine()).toHaveTextContent('анатомия не определена')
    expect(anatomyLine()).not.toHaveTextContent('unknown')
  })

  it('молчит об эпохе без диполя с MNI: анатомию соседа не подставляет', () => {
    renderLine({ epochIndex: 1, points: [scanPoint(0)] })

    expect(screen.getByText('Кадр: эпоха 2 — диполя с MNI нет')).toBeInTheDocument()
  })

  it('не подписывает кадр, скрытый порогом «КД»: подпись не должна спорить с картинкой', () => {
    renderLine({ epochIndex: 0, threshold: 100 })

    expect(
      screen.getByText('Кадр: эпоха 1 — скрыт порогом «КД ≥ 100 нАм»'),
    ).toBeInTheDocument()
  })

  it('не показывается, пока кадр не задействован', () => {
    const { container } = renderLine({ active: false })

    expect(container).toBeEmptyDOMElement()
  })

  it('молчит при выключенном слое «Кадр воспроизведения»: кадра на фигуре нет', () => {
    useDipoleParams.setState({
      params: {
        ...DIPOLE_PARAM_DEFAULTS,
        layerVisibility: { ...DIPOLE_PARAM_DEFAULTS.layerVisibility, playback: false },
      },
    })
    const { container } = renderLine({ active: true, epochIndex: 0 })

    expect(container).toBeEmptyDOMElement()
  })

  it('не делает ни одного запроса: анатомия уже в результате', () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    renderLine({ epochIndex: 0 })

    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
