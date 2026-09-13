/**
 * Тесты состояния раздела EDF: паспорт сессии, запрос диалога выбора файла
 * и локальная валидация до отправки на сервер.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_PASSPORT,
  acceptEdfFile,
  useEdfRecording,
  validateEdfFile,
} from '@/shared/state/edfRecording'
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
})
