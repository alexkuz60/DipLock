/**
 * Тесты кусочной загрузки WAV (`fetchWavChunks`): мастер рендера — десятки
 * мегабайт, и один такой ответ через облачный ingress обрывается
 * (`NetworkError` в `fetch`). Здесь проверяется контракт докачки: `Range`,
 * параллельные куски, склейка по порядку, повтор упавшего куска, прогресс и
 * фоллбэк на сервер без `Range`.
 *
 * Tone не поднимается: jsdom без Web Audio, а `fetchWavChunks` работает с
 * байтами и `fetch` — движок мокается пустой заглушкой.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WAV_CHUNK_BYTES, fetchWavChunks } from './neuromusicPlayer'

vi.mock('tone', () => ({ getContext: () => ({ decodeAudioData: vi.fn() }) }))

/** Тело фиктивного файла: байт i = i % 251 (различимо на любом срезе). */
function payload(size: number): Uint8Array {
  const body = new Uint8Array(size)
  for (let index = 0; index < size; index++) body[index] = index % 251
  return body
}

/** Контрольная сумма: сравнение 8 МБ через `toEqual` слишком медленное. */
function checksum(data: Uint8Array): number {
  let sum = 0
  for (let index = 0; index < data.length; index++) sum = (sum * 31 + data[index]) % 1_000_000_007
  return sum
}

/** Заголовок `Range` из init мока: плеер передаёт простой объект. */
function rangeOf(init?: RequestInit): string {
  const headers = (init?.headers ?? {}) as Record<string, string>
  return headers.Range ?? headers.range ?? ''
}

/** Сервер с `Range`: 206 + `Content-Range`, как `byte_range_response`. */
function rangeServer(body: Uint8Array) {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const [, span] = rangeOf(init).split('=')
    const [startText, endText] = span.split('-')
    const start = Number(startText)
    const end = Math.min(Number(endText), body.length - 1)
    return new Response(body.slice(start, end + 1).buffer as ArrayBuffer, {
      status: 206,
      headers: { 'Content-Range': `bytes ${start}-${end}/${body.length}` },
    })
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchWavChunks', () => {
  it('качает файл кусками по Range и склеивает байты по порядку', async () => {
    const body = payload(WAV_CHUNK_BYTES * 2 + 1000)
    const fetchMock = rangeServer(body)
    vi.stubGlobal('fetch', fetchMock)

    const merged = new Uint8Array(await fetchWavChunks('/api/v1/audio/render/x/master.wav'))

    expect(merged.byteLength).toBe(body.byteLength)
    expect(checksum(merged)).toBe(checksum(body))
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(rangeOf(fetchMock.mock.calls[0][1])).toBe(`bytes=0-${WAV_CHUNK_BYTES - 1}`)
    expect(rangeOf(fetchMock.mock.calls[1][1])).toBe(
      `bytes=${WAV_CHUNK_BYTES}-${WAV_CHUNK_BYTES * 2 - 1}`,
    )
  })

  it('держит не больше четырёх кусков в полёте и отдаёт прогресс до 100 %', async () => {
    const body = payload(WAV_CHUNK_BYTES * 9)
    const server = rangeServer(body)
    let inFlight = 0
    let peak = 0
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Promise.resolve()
      try {
        return await server(url, init)
      } finally {
        inFlight -= 1
      }
    })
    vi.stubGlobal('fetch', fetchMock)
    const seen: number[] = []

    const merged = new Uint8Array(
      await fetchWavChunks('/master.wav', (loaded, total) => {
        expect(total).toBe(body.byteLength)
        seen.push(loaded)
      }),
    )

    expect(checksum(merged)).toBe(checksum(body))
    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1) // куски действительно идут параллельно
    expect(seen.at(-1)).toBe(body.byteLength)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen) // прогресс не откатывается
  })

  it('повторяет упавший кусок и не теряет байты', async () => {
    const body = payload(WAV_CHUNK_BYTES + 10)
    const server = rangeServer(body)
    let failed = false
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const range = rangeOf(init)
      if (!failed && range.startsWith(`bytes=${WAV_CHUNK_BYTES}-`)) {
        failed = true
        throw new TypeError('NetworkError when attempting to fetch resource.')
      }
      return server(url, init)
    })
    vi.stubGlobal('fetch', fetchMock)

    const merged = new Uint8Array(await fetchWavChunks('/master.wav'))

    expect(checksum(merged)).toBe(checksum(body))
    expect(fetchMock).toHaveBeenCalledTimes(3) // 1-й кусок, обрыв, повтор
  })

  it('берёт тело целиком, если сервер не поддержал Range (200)', async () => {
    const body = payload(2048)
    const fetchMock = vi.fn(async () => new Response(body.buffer as ArrayBuffer, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const merged = new Uint8Array(await fetchWavChunks('/master.wav'))

    expect(checksum(merged)).toBe(checksum(body))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('отдаёт HTTP-статус в тексте ошибки (404 не повторяется)', async () => {
    const fetchMock = vi.fn(async () => new Response('нет', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchWavChunks('/master.wav')).rejects.toThrow('HTTP 404')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
