/** Тесты HTTP-клиента: разбор ошибок FastAPI и базовые запросы. */
import { describe, expect, it, vi } from 'vitest'
import { ApiError, api, apiErrorText } from './client'
import { mockApiFetch } from '@/test/apiMocks'

describe('apiErrorText', () => {
  it('возвращает detail строкой от FastAPI', () => {
    const error = new ApiError('epo', 400, 'epoch_length_ms должен быть одним из [250, 500]')
    expect(apiErrorText(error)).toContain('epoch_length_ms')
  })

  it('собирает ошибки валидации FastAPI в читаемый текст', () => {
    const detail = [
      { loc: ['body', 'epoch_length_ms'], msg: 'value is not a valid float' },
      { loc: ['body', 'freq_band'], msg: 'unexpected value' },
    ]
    const text = apiErrorText(new ApiError('422', 422, detail))
    expect(text).toBe('epoch_length_ms: value is not a valid float; freq_band: unexpected value')
  })

  it('возвращает текст обычной ошибки', () => {
    expect(apiErrorText(new Error('boom'))).toBe('boom')
  })
})

describe('api', () => {
  it('recordingSignals несёт слой и параметры подготовки в query (шаг 2 плана)', async () => {
    const fetchMock = mockApiFetch()

    await api.recordingSignals('rec1', 2)
    await api.recordingSignals('rec1', 2, {
      layer: 'cleaned',
      prep: { band_min: 1, band_max: 40, clean_method: 'ica', bad_channels: '' },
    })

    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    // Сырой слой: только уровень и слой — параметры подготовки не шлются вовсе
    expect(urls[0]).toContain('level=2')
    expect(urls[0]).toContain('layer=raw')
    expect(urls[0]).not.toContain('band_min')
    // Подготовленные слои: та же форма, что стадия «Фильтр и референс»
    expect(urls[1]).toContain('layer=cleaned')
    expect(urls[1]).toContain('band_min=1')
    expect(urls[1]).toContain('band_max=40')
    expect(urls[1]).toContain('clean_method=ica')
    // Пустые значения не засоряют query (notch выключен, bad-каналов нет)
    expect(urls[1]).not.toContain('notch_hz=')
    expect(urls[1]).not.toContain('bad_channels')

    // Слой band (Фаза B): band_key уезжает в query тем же механизмом prep
    await api.recordingSignals('rec1', 2, {
      layer: 'band',
      prep: { band_key: 'mu', notch_hz: 50 },
    })
    const bandUrl = fetchMock.mock.calls.map(([url]) => String(url))[2] ?? ''
    expect(bandUrl).toContain('layer=band')
    expect(bandUrl).toContain('band_key=mu')
    expect(bandUrl).toContain('notch_hz=50')
    expect(bandUrl).not.toContain('clean_method')
  })

  it('meta() возвращает разобранный JSON', async () => {
    mockApiFetch()
    const meta = await api.meta()
    expect(meta.app).toBe('DipLock')
    expect(meta.freq_bands.alpha).toEqual([8, 16])
    // Функциональные ритмы — отдельным полем (фаза A: только пресеты фильтра)
    expect(meta.functional_bands.mu).toEqual([8, 13])
  })

  it('бросает ApiError с detail при ошибке HTTP', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: 'Сервис недоступен' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    )

    await expect(api.meta()).rejects.toBeInstanceOf(ApiError)
    await expect(api.meta()).rejects.toThrow('Сервис недоступен')
  })

  it('сообщает о недоступном сервере понятным текстом', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    await expect(api.initStatus()).rejects.toThrow(/Сервер недоступен/)
  })
})
