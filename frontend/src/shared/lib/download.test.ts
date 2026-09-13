/**
 * Тесты доставки файла (срез 2.8): ссылка на Blob, текст и кодирование canvas.
 *
 * jsdom не реализует `URL.createObjectURL`/`toBlob`, поэтому обе точки подменены
 * заглушками — проверяется контракт (имя файла, MIME, освобождение URL, текст
 * ошибки), а не реальное скачивание.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canvasToBlob, downloadBlob, downloadText } from '@/shared/lib/download'

/** Заглушки объекта-URL: jsdom без них падает на createObjectURL. */
function stubObjectUrl() {
  const created: Blob[] = []
  const create = vi.fn((blob: Blob) => {
    created.push(blob)
    return 'blob:mock'
  })
  const revoke = vi.fn()
  vi.stubGlobal('URL', { ...URL, createObjectURL: create, revokeObjectURL: revoke })
  return { create, revoke, created }
}

describe('скачивание Blob', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('создаёт ссылку с именем файла, кликает и освобождает URL', () => {
    const { create, revoke } = stubObjectUrl()
    const blob = new Blob(['x'], { type: 'text/plain' })
    const clicks: string[] = []
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push(this.download)
      })

    downloadBlob('probe-win0.00-10.00s-level1.csv', blob)

    expect(create).toHaveBeenCalledWith(blob)
    expect(clicks).toEqual(['probe-win0.00-10.00s-level1.csv'])
    // Ссылка не остаётся в DOM, а URL не течёт: освобождён ровно один раз
    expect(document.querySelectorAll('a')).toHaveLength(0)
    expect(revoke).toHaveBeenCalledWith('blob:mock')
    click.mockRestore()
  })

  it('текст уходит в файл с CSV-MIME', async () => {
    const { created } = stubObjectUrl()
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    downloadText('probe.csv', 'time_sec,channel\n')

    const saved = created[0] as Blob
    expect(saved.type).toBe('text/csv;charset=utf-8')
    // В jsdom у Blob нет .text() — читаем содержимое через FileReader
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsText(saved)
    })
    expect(text).toBe('time_sec,channel\n')
    click.mockRestore()
  })
})

describe('кодирование canvas в PNG', () => {
  afterEach(() => vi.restoreAllMocks())

  it('отдаёт Blob, который вернул toBlob', async () => {
    const canvas = document.createElement('canvas')
    const blob = new Blob(['png'], { type: 'image/png' })
    const toBlob = vi.fn((callback: BlobCallback) => callback(blob))
    canvas.toBlob = toBlob as unknown as HTMLCanvasElement['toBlob']

    await expect(canvasToBlob(canvas)).resolves.toBe(blob)
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png')
  })

  it('падает с понятным текстом, если браузер не умеет toBlob', async () => {
    const canvas = document.createElement('canvas')
    // @ts-expect-error — воспроизводим окружение без поддержки toBlob
    canvas.toBlob = undefined

    await expect(canvasToBlob(canvas)).rejects.toThrow('PNG-экспорт не поддерживается браузером')
  })

  it('падает, если холст не закодировался (пустой Blob)', async () => {
    const canvas = document.createElement('canvas')
    canvas.toBlob = vi.fn((callback: BlobCallback) => callback(null)) as unknown as
      HTMLCanvasElement['toBlob']

    await expect(canvasToBlob(canvas)).rejects.toThrow('Не удалось собрать PNG')
  })
})