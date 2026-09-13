/**
 * Тесты кнопок экспорта окна (срез 2.8).
 *
 * Доставка файла подменена (`@/shared/lib/download`): проверяем связку
 * «состояние вьюера → имя файла + содержимое», а не реальное скачивание
 * (его контракт покрыт в `download.test.ts`). Экспорт клиентский, поэтому
 * отдельно проверяется, что он не ходит на сервер.
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SignalFrame } from '@/shared/lib/signalFrame'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'

import { ExportActions } from './ExportActions'

vi.mock('@/shared/lib/download', () => ({
  downloadBlob: vi.fn(),
  downloadText: vi.fn(),
  canvasToBlob: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}))

const { canvasToBlob, downloadBlob, downloadText } = await import('@/shared/lib/download')

/** Кадр огибающей ×1: 10 корзин за 10 с, min = −i, max = +i (арифметика проверяема). */
function frameFixture(): SignalFrame {
  const nPoints = 10
  const times = new Float32Array(nPoints)
  const min: Record<string, Float32Array> = {}
  const max: Record<string, Float32Array> = {}
  for (const name of ['F3', 'F4']) {
    const lo = new Float32Array(nPoints)
    const hi = new Float32Array(nPoints)
    for (let i = 0; i < nPoints; i++) {
      lo[i] = -i
      hi[i] = i
    }
    min[name] = lo
    max[name] = hi
  }
  for (let i = 0; i < nPoints; i++) times[i] = i + 0.5
  return {
    sourceId: 'rec-1',
    channels: ['F3', 'F4'],
    durationSec: 10,
    times,
    min,
    max,
    decimated: true,
    level: 1,
  }
}

const PNG_BUTTON = 'Скачать PNG окна'
const CSV_BUTTON = 'Скачать CSV окна'

function props(patch: Partial<Parameters<typeof ExportActions>[0]> = {}) {
  return {
    frame: frameFixture(),
    window: { t0: 0, t1: 10 },
    channels: ['F3', 'F4'],
    trackWidth: 600,
    canvases: {} as Record<string, HTMLCanvasElement | null>,
    zones: [],
    epochs: [],
    showEpochBoundaries: true,
    showDroppedEpochs: true,
    amplitudeMode: 'shared' as const,
    amplitudeScaleUv: 100,
    ...patch,
  }
}

describe('экспорт окна вьюера', () => {
  beforeEach(() => {
    useEdfRecording.setState({ recording: { ...recordingFixture } })
    vi.clearAllMocks()
    vi.mocked(canvasToBlob).mockResolvedValue(new Blob(['png'], { type: 'image/png' }))
    // jsdom без пакета `canvas` бросает на getContext: рисуем «в никуда»,
    // но кнопка обязана работать и без 2D-контекста
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('блокирует кнопки, когда экспортировать нечего', () => {
    renderWithProviders(<ExportActions {...props({ channels: [] })} />)

    expect(screen.getByRole('button', { name: PNG_BUTTON })).toBeDisabled()
    expect(screen.getByRole('button', { name: CSV_BUTTON })).toBeDisabled()
  })

  it('CSV: пишет строку на (корзина × канал) и не обращается к серверу', async () => {
    const user = userEvent.setup()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    renderWithProviders(<ExportActions {...props()} />)

    await user.click(screen.getByRole('button', { name: CSV_BUTTON }))

    expect(downloadText).toHaveBeenCalledTimes(1)
    const [name, csv] = vi.mocked(downloadText).mock.calls[0] as [string, string]
    expect(name).toBe('probe-win0.00-10.00s-level1.csv')

    const lines = csv.split('\n')
    expect(lines[0]).toBe('time_sec,channel,min_uv,max_uv')
    // 10 корзин × 2 канала + заголовок + пустая строка от финального \n
    expect(lines).toHaveLength(22)
    expect(lines[1]).toBe('0.500,F3,0.0000,0.0000')
    expect(lines[2]).toBe('0.500,F4,0.0000,0.0000')
    expect(lines[3]).toBe('1.500,F3,-1.0000,1.0000')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('CSV учитывает окно: за его пределами корзин нет', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ExportActions {...props({ window: { t0: 2, t1: 4 } })} />)

    await user.click(screen.getByRole('button', { name: CSV_BUTTON }))

    const [name, csv] = vi.mocked(downloadText).mock.calls[0] as [string, string]
    expect(name).toBe('probe-win2.00-4.00s-level1.csv')
    // Корзины 2.5 и 3.5 → по два канала плюс заголовок
    expect(csv.trim().split('\n')).toHaveLength(5)
    expect(csv).toContain('2.500,F3,-2.0000,2.0000')
    expect(csv).not.toContain('0.500')
  })

  it('PNG: кодирует снапшот и скачивает файл под именем окна', async () => {
    const user = userEvent.setup()
    renderWithProviders(<ExportActions {...props()} />)

    await user.click(screen.getByRole('button', { name: PNG_BUTTON }))

    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1))
    expect(canvasToBlob).toHaveBeenCalledTimes(1)
    const [name, blob] = vi.mocked(downloadBlob).mock.calls[0] as [string, Blob]
    expect(name).toBe('probe-win0.00-10.00s-level1.png')
    expect(blob.type).toBe('image/png')
    // Ошибки нет — полоса с текстом не появляется
    expect(screen.queryByText(/^Экспорт:/)).not.toBeInTheDocument()
  })

  it('ошибка кодирования PNG показывается текстом, а не пустым файлом', async () => {
    const user = userEvent.setup()
    vi.mocked(canvasToBlob).mockRejectedValue(new Error('PNG-экспорт не поддерживается браузером'))
    renderWithProviders(<ExportActions {...props()} />)

    await user.click(screen.getByRole('button', { name: PNG_BUTTON }))

    expect(await screen.findByText(/PNG-экспорт не поддерживается/)).toBeInTheDocument()
    expect(downloadBlob).not.toHaveBeenCalled()
  })

  it('имя демо-сигнала (без записи) не ломает экспорт', async () => {
    const user = userEvent.setup()
    useEdfRecording.setState({ recording: null })
    renderWithProviders(<ExportActions {...props()} />)

    await user.click(screen.getByRole('button', { name: CSV_BUTTON }))

    const [name] = vi.mocked(downloadText).mock.calls[0] as [string, string]
    expect(name).toBe('demo-signal-win0.00-10.00s-level1.csv')
  })
})
