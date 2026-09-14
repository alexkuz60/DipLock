/**
 * Тесты рабочей области раздела EDF (срез 2.2–2.3).
 *
 * Проверяют то, что видно пользователю: пустое состояние, отбор файлов по
 * расширению/размеру, загрузку с прогрессом и результат в сторе. Рендер треков
 * отдельно покрыт в `viewer/TrackStack.test.tsx`.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EdfSection } from './EdfSection'
import { EDF_PARAM_DEFAULTS, emptyStageSnapshot, useEdfParams } from '@/shared/state/edfParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { mockApiFetch } from '@/test/apiMocks'
import { recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'

/** Файл с заданным именем и «весом» (байты не аллоцируем — важен только size). */
function edfFile(name = 'probe.edf', size = 1024): File {
  const file = new File([new Uint8Array(16)], name, { type: 'application/octet-stream' })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

/** Подмена XHR: загрузка подтверждается успехом и паспортом записи. */
function stubUpload(status = 201) {
  const instances: { url: string; body: FormData | null }[] = []

  class FakeXhr {
    status = 0
    response: unknown = null
    upload = { onprogress: null as null | ((event: ProgressEvent) => void) }
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    ontimeout: (() => void) | null = null
    open(_method: string, url: string) {
      instances.push({ url, body: null })
    }
    send(body: FormData) {
      instances[instances.length - 1].body = body
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 } as ProgressEvent)
      queueMicrotask(() => {
        this.status = status
        this.response = status < 300 ? recordingFixture : { detail: 'Файл слишком большой' }
        this.onload?.()
      })
    }
  }

  vi.stubGlobal('XMLHttpRequest', FakeXhr as unknown as typeof XMLHttpRequest)
  return instances
}

describe('рабочая область раздела EDF', () => {
  beforeEach(() => {
    localStorage.clear()
    useEdfParams.setState({
      params: { ...EDF_PARAM_DEFAULTS },
      availableChannels: [],
      stageApplied: emptyStageSnapshot(),
    })
    useEdfRecording.setState({
      recording: null,
      uploadProgress: null,
      uploadError: null,
      demo: null,
      signalFrames: {},
      signalsPending: 0,
      signalsError: null,
      layers: null,
    })
  })

  afterEach(() => {
    useEdfRecording.getState().closeRecording()
  })

  it('без записи показывает зону загрузки и говорит, что расчёт не запускается', () => {
    mockApiFetch()
    renderWithProviders(<EdfSection />)

    expect(screen.getByText('Файл записи не загружен')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Выбрать файл EDF/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Демо-сигнал/ })).toBeInTheDocument()
    expect(screen.getByText(/обработка артефактов и шума запускается отдельными действиями/)).toBeInTheDocument()
  })

  it('пропускает слои записи в вьюер: зоны и легенда появляются вместе с треками', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    stubUpload()
    renderWithProviders(<EdfSection />)

    await user.upload(screen.getByLabelText('Выбрать файл EDF'), edfFile())
    await waitFor(() => expect(useEdfRecording.getState().signalFrames[1]).toBeTruthy())

    // Слои построены под длину и монтаж записи и отрисованы поверх треков
    expect(screen.getByTestId('track-layers')).toBeInTheDocument()
    expect(screen.getAllByTestId(/^legend-/)).toHaveLength(4)
    expect(screen.getByText('слои: демо-фикстура')).toBeInTheDocument()
  })

  it('загружает выбранный файл: запись в сторе и треки вместо зоны загрузки', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    const requests = stubUpload()
    renderWithProviders(<EdfSection />)

    await user.upload(screen.getByLabelText('Выбрать файл EDF'), edfFile())

    // Данные записи показываются в диалоге «Паспорт» (тулс-хедер), а не в области:
    // здесь достаточно, что запись загружена и треки встали на место dropzone.
    await waitFor(() => expect(useEdfRecording.getState().recording).toEqual(recordingFixture))
    expect(await screen.findByTestId('track-stack')).toBeInTheDocument()
    expect(screen.queryByText('Файл записи не загружен')).not.toBeInTheDocument()
    // Каналы записи попадают в параметры раздела
    expect(useEdfParams.getState().availableChannels).toEqual(recordingFixture.channels)
    expect(requests[0].url).toContain('/recordings')
    expect(requests[0].body?.get('file')).toBeInstanceOf(File)
    expect(useEdfRecording.getState().uploadError).toBeNull()
  })

  it('рисует треки записи из её сигналов: уровень ×1 грузится сразу', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    stubUpload()
    renderWithProviders(<EdfSection />)

    await user.upload(screen.getByLabelText('Выбрать файл EDF'), edfFile())

    // Догрузка уровня ×1 в стор идёт асинхронно — ждём её, а не только паспорт
    await waitFor(() => expect(useEdfRecording.getState().signalFrames[1]).toBeTruthy())

    const signalsCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/signals'))
    expect(signalsCalls).toHaveLength(1)
    expect(signalsCalls[0]).toContain(`/recordings/${recordingFixture.recording_id}/signals?level=1`)
    // Кадр записи (а не демо) уходит во вьюер: первый канал монтage получает трек
    expect(await screen.findByTestId(`track-${recordingFixture.channels[0]}`)).toBeInTheDocument()
  })

  it('сообщает об ошибке сервера и не оставляет запись', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    stubUpload(413)
    renderWithProviders(<EdfSection />)

    await user.upload(screen.getByLabelText('Выбрать файл EDF'), edfFile())

    expect(await screen.findByText('Файл слишком большой')).toBeInTheDocument()
    expect(useEdfRecording.getState().recording).toBeNull()
    expect(useEdfRecording.getState().uploadProgress).toBeNull()
  })

  it('отклоняет файл без расширения .edf и слишком большой, не отправляя запрос', async () => {
    mockApiFetch()
    const requests = stubUpload()
    renderWithProviders(<EdfSection />)

    const input = screen.getByLabelText('Выбрать файл EDF')
    fireEvent.change(input, { target: { files: [edfFile('probe.txt')] } })

    expect(await screen.findByText(/«probe\.txt» — не EDF/)).toBeInTheDocument()

    fireEvent.change(input, { target: { files: [edfFile('huge.edf', 300 * 1024 * 1024)] } })

    expect(await screen.findByText(/«huge\.edf» слишком большой/)).toBeInTheDocument()
    expect(await screen.findByText(/максимум 200 МБ/)).toBeInTheDocument()
    expect(requests).toHaveLength(0)
  })

  it('кнопка «Демо-сигнал» включает синтетику без обращения к серверу', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApiFetch()
    renderWithProviders(<EdfSection />)

    await user.click(screen.getByRole('button', { name: /Демо-сигнал/ }))

    expect(useEdfRecording.getState().demo).not.toBeNull()
    expect(await screen.findByText(/Демо-сигнал \(синтетика\)/)).toBeInTheDocument()
    expect(screen.getByTestId('track-stack')).toBeInTheDocument()
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls.every((url) => url.includes('/meta'))).toBe(true)
  })

  it('демо-каналы становятся доступными в параметрах раздела', async () => {
    const user = userEvent.setup()
    mockApiFetch()
    renderWithProviders(<EdfSection />)

    await user.click(screen.getByRole('button', { name: /Демо-сигнал/ }))

    await waitFor(() =>
      expect(useEdfParams.getState().availableChannels).toEqual(
        useEdfRecording.getState().demo?.channels,
      ),
    )
    expect(useEdfParams.getState().params.visibleChannels.length).toBeGreaterThan(0)
  })
})
