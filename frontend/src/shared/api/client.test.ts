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
  it('meta() возвращает разобранный JSON', async () => {
    mockApiFetch()
    const meta = await api.meta()
    expect(meta.app).toBe('DipLock')
    expect(meta.freq_bands.alpha).toEqual([8, 13])
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
