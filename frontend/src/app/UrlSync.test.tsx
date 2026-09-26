/**
 * Тесты зеркала URL ↔ сторы (3.2б, N33): применение ссылки при старте,
 * дописывание параметров при изменении сторов и при смене секции.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { api } from '@/shared/api/client'
import { CALC_PARAM_DEFAULTS } from '@/shared/lib/dipoleCalcModel'
import { defaultSlices } from '@/shared/lib/mriProjections'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { DIPOLE_PARAM_DEFAULTS, EMPTY_SELECTION, useDipoleParams } from '@/shared/state/dipoleParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { recordingFixture } from '@/test/fixtures'
import { UrlSync } from './UrlSync'

/** Текущий location для проверок: рендерится внутри роутера. */
function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname + location.search}</div>
}

/** Состояние «как на старте»: URL-применение должно быть видно на чистых сторах. */
function resetStores() {
  localStorage.clear()
  useEdfRecording.setState({
    recording: null,
    uploadProgress: null,
    uploadError: null,
    demo: null,
  })
  useDipoleCalc.setState({ params: { ...CALC_PARAM_DEFAULTS } })
  useDipoleParams.setState({
    params: { ...DIPOLE_PARAM_DEFAULTS, slices: defaultSlices() },
    selection: EMPTY_SELECTION,
  })
}

/** Query текущего location из пробы (URLSearchParams декодирует %3A/%2C). */
function currentQuery(): URLSearchParams {
  const text = screen.getByTestId('location').textContent ?? ''
  return new URLSearchParams(text.split('?')[1] ?? '')
}

describe('UrlSync (3.2б)', () => {
  beforeEach(() => resetStores())
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('применяет rec, band и slice из ссылки при старте', async () => {
    const metaSpy = vi.spyOn(api, 'recording').mockResolvedValue(recordingFixture)

    render(
      <MemoryRouter initialEntries={['/dipoles?rec=rec-1&band=8-13&slice=axial:12']}>
        <Routes>
          <Route path="/dipoles" element={<div>dipoles-section</div>} />
        </Routes>
        <UrlSync />
        <LocationProbe />
      </MemoryRouter>,
    )

    // band и срезы применяются синхронно в эффекте первого рендера
    expect(useDipoleCalc.getState().params.filterBandHz).toEqual([8, 13])
    expect(useDipoleParams.getState().params.slices.axial).toBe(12)
    // Запись открывается паспортом из реестра (async)
    await waitFor(() => expect(metaSpy).toHaveBeenCalledWith('rec-1'))
    await waitFor(() =>
      expect(useEdfRecording.getState().recording?.recording_id).toBe('rec-1'),
    )
  })

  it('изменение параметра в сторе дописывает URL (debounce, replace)', () => {
    vi.useFakeTimers()
    render(
      <MemoryRouter initialEntries={['/dipoles']}>
        <Routes>
          <Route path="/dipoles" element={<div>dipoles-section</div>} />
        </Routes>
        <UrlSync />
        <LocationProbe />
      </MemoryRouter>,
    )

    act(() => {
      useDipoleParams.getState().setSlice('axial', 30)
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })

    expect(currentQuery().get('slice')).toContain('axial:30')
  })

  it('дефолтные значения в URL не появляются (зеркало без шума)', () => {
    vi.useFakeTimers()
    render(
      <MemoryRouter initialEntries={['/edf']}>
        <Routes>
          <Route path="/edf" element={<div>edf-section</div>} />
        </Routes>
        <UrlSync />
        <LocationProbe />
      </MemoryRouter>,
    )

    act(() => {
      vi.advanceTimersByTime(300)
    })

    const text = screen.getByTestId('location').textContent ?? ''
    expect(text).not.toContain('band=')
    expect(text).not.toContain('slice=')
    expect(text).not.toContain('rec=')
  })

  it('смена секции не теряет параметры: Link не несёт search, зеркало дописывает', () => {
    vi.useFakeTimers()
    render(
      <MemoryRouter initialEntries={['/edf']}>
        <Routes>
          <Route
            path="/edf"
            element={
              <Link to="/eeg" data-testid="go-eeg">
                в ээг
              </Link>
            }
          />
          <Route path="/eeg" element={<div>eeg-section</div>} />
        </Routes>
        <UrlSync />
        <LocationProbe />
      </MemoryRouter>,
    )

    // недефолтная полоса появляется в URL
    act(() => {
      useDipoleCalc.getState().setFilterBand([8, 13])
    })
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(currentQuery().get('band')).toBe('8-13')

    // смена секции: Link убирает search из адреса…
    act(() => {
      fireEvent.click(screen.getByTestId('go-eeg'))
    })
    expect(screen.getByTestId('location').textContent).toContain('/eeg')

    // …а зеркало дозаписывает параметры сторов обратно
    act(() => {
      vi.advanceTimersByTime(300)
    })
    const location = screen.getByTestId('location').textContent ?? ''
    expect(location).toContain('/eeg')
    expect(currentQuery().get('band')).toBe('8-13')
  })

  it('закрытие записи убирает rec из URL', async () => {
    vi.useFakeTimers()
    vi.spyOn(api, 'recording').mockResolvedValue(recordingFixture)
    render(
      <MemoryRouter initialEntries={['/edf?rec=rec-1']}>
        <Routes>
          <Route path="/edf" element={<div>edf-section</div>} />
        </Routes>
        <UrlSync />
        <LocationProbe />
      </MemoryRouter>,
    )
    // отдаём микротаски: паспорт записи открывается без реальных таймеров
    await act(async () => {})
    expect(useEdfRecording.getState().recording?.recording_id).toBe('rec-1')

    // После открытия запись отражена в URL
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(currentQuery().get('rec')).toBe('rec-1')

    act(() => {
      useEdfRecording.getState().closeRecording()
      vi.advanceTimersByTime(300)
    })
    expect(currentQuery().get('rec')).toBeNull()
  })
})