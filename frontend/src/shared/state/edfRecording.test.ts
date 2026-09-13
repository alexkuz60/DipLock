/**
 * Тесты состояния раздела EDF: паспорт сессии, запрос диалога выбора файла,
 * локальная валидация до отправки на сервер и догрузка кадров сигналов (2.5).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_PASSPORT,
  acceptEdfFile,
  useEdfRecording,
  validateEdfFile,
} from '@/shared/state/edfRecording'
import { mockApiFetch } from '@/test/apiMocks'
import { recordingFixture } from '@/test/fixtures'

/** Файл с заданным именем и «весом» (байты не аллоцируем — важен только size). */
function edfFile(name = 'probe.edf', size = 1024): File {
  const file = new File([new Uint8Array(8)], name, { type: 'application/octet-stream' })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('состояние раздела EDF', () => {
  beforeEach(() => {
    useEdfRecording.setState({
      recording: null,
      demo: null,
      uploadProgress: null,
      uploadError: null,
      passport: { ...EMPTY_PASSPORT },
      fileDialogRequest: 0,
      signalFrames: {},
      signalsPending: 0,
      signalsError: null,
    })
  })

  it('паспорт принадлежит сессии: заполняется именем файла и очищается с записью', () => {
    useEdfRecording.getState().finishUpload(recordingFixture)

    expect(useEdfRecording.getState().passport.title).toBe(recordingFixture.filename)
    expect(useEdfRecording.getState().passport.units).toBe('auto')

    useEdfRecording.getState().setPassport({ subject: 'S-01', units: 'uV' })
    expect(useEdfRecording.getState().passport.subject).toBe('S-01')

    useEdfRecording.getState().closeRecording()
    expect(useEdfRecording.getState().passport).toEqual(EMPTY_PASSPORT)
    expect(useEdfRecording.getState().recording).toBeNull()
  })

  it('requestFileDialog считает запросы тулс-хедара к рабочей области', () => {
    expect(useEdfRecording.getState().fileDialogRequest).toBe(0)

    useEdfRecording.getState().requestFileDialog()
    useEdfRecording.getState().requestFileDialog()

    expect(useEdfRecording.getState().fileDialogRequest).toBe(2)
  })

  it('validateEdfFile отсекает не-EDF и файлы больше 200 МБ', () => {
    expect(validateEdfFile(edfFile())).toBeNull()
    expect(validateEdfFile(edfFile('probe.txt'))).toMatch(/не EDF/)
    expect(validateEdfFile(edfFile('huge.edf', 300 * 1024 * 1024))).toMatch(/максимум 200 МБ/)
  })

  it('acceptEdfFile с негодным файлом объясняет отказ и ничего не отправляет', () => {
    const xhr = vi.fn()
    vi.stubGlobal('XMLHttpRequest', xhr)

    acceptEdfFile(edfFile('probe.txt'))

    expect(useEdfRecording.getState().uploadError).toMatch(/не EDF/)
    expect(useEdfRecording.getState().uploadProgress).toBeNull()
    expect(xhr).not.toHaveBeenCalled()
  })

  it('acceptEdfFile игнорирует пустой выбор (отмена в диалоге)', () => {
    acceptEdfFile(undefined)
    acceptEdfFile(null)

    expect(useEdfRecording.getState().uploadError).toBeNull()
  })

  it('loadSignals кэширует уровень: повторный вызов не делает запрос', async () => {
    const fetchMock = mockApiFetch()
    useEdfRecording.getState().finishUpload(recordingFixture)

    await useEdfRecording.getState().loadSignals(1)
    const frame = useEdfRecording.getState().signalFrames[1]
    expect(frame?.sourceId).toBe(recordingFixture.recording_id)
    expect(frame?.channels).toEqual(recordingFixture.channels)
    expect(useEdfRecording.getState().signalsPending).toBe(0)
    expect(useEdfRecording.getState().signalsError).toBeNull()

    await useEdfRecording.getState().loadSignals(1)
    const signalsCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/signals'),
    )
    expect(signalsCalls).toHaveLength(1)
    expect(String(signalsCalls[0][0])).toContain('level=1')
  })

  it('loadSignals без записи ничего не делает', async () => {
    const fetchMock = mockApiFetch()

    await useEdfRecording.getState().loadSignals(1)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(useEdfRecording.getState().signalFrames).toEqual({})
  })

  it('loadSignals сохраняет ошибку сервера и снимает индикатор', async () => {
    mockApiFetch({ signalsFail: true })
    useEdfRecording.getState().finishUpload(recordingFixture)

    await useEdfRecording.getState().loadSignals(1)

    expect(useEdfRecording.getState().signalFrames).toEqual({})
    expect(useEdfRecording.getState().signalsError).toMatch(/не найдена/)
    expect(useEdfRecording.getState().signalsPending).toBe(0)
  })

  it('смена записи сбрасывает кэш кадров сигналов и ошибку', () => {
    useEdfRecording.setState({
      signalFrames: { 1: { level: 1 } as never },
      signalsError: 'старая ошибка',
    })

    useEdfRecording.getState().finishUpload(recordingFixture)

    expect(useEdfRecording.getState().signalFrames).toEqual({})
    expect(useEdfRecording.getState().signalsError).toBeNull()
  })
})
