/**
 * Тесты диалога «Паспорт сессии»: просмотр факта о записи, правка черновика
 * и явное сохранение. Файл-исходник не меняется — значения идут в стор,
 * оттуда их заберёт запись в БД.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionPassportDialog } from './SessionPassportDialog'
import { EMPTY_PASSPORT, useEdfRecording } from '@/shared/state/edfRecording'
import { recordingFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'

describe('диалог паспорта сессии', () => {
  beforeEach(() => {
    useEdfRecording.setState({ recording: recordingFixture, passport: { ...EMPTY_PASSPORT } })
  })

  it('показывает факты о записи и предупреждает, что файл не меняется', () => {
    renderWithProviders(<SessionPassportDialog open onClose={vi.fn()} />)

    expect(screen.getByRole('dialog', { name: 'Паспорт сессии' })).toBeInTheDocument()
    expect(screen.getByText(recordingFixture.filename)).toBeInTheDocument()
    expect(screen.getByText(`${recordingFixture.sfreq} Гц`)).toBeInTheDocument()
    expect(screen.getByText(/правка паспорта его не меняет/)).toBeInTheDocument()
    // Правки уходят в БД, а не в файл
    expect(screen.getByText(/попадут в таблицу сессий при запуске анализа/)).toBeInTheDocument()
  })

  it('сохраняет черновик в стор по кнопке «Сохранить»', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderWithProviders(<SessionPassportDialog open onClose={onClose} />)

    await user.type(screen.getByLabelText('Испытуемый'), 'S-42')
    await user.type(screen.getByLabelText('Заметки'), 'спокойное состояние')

    // До сохранения стор не тронут: правка идёт в черновик
    expect(useEdfRecording.getState().passport.subject).toBe('')

    await user.click(screen.getByRole('button', { name: 'Сохранить' }))

    expect(useEdfRecording.getState().passport.subject).toBe('S-42')
    expect(useEdfRecording.getState().passport.notes).toBe('спокойное состояние')
    expect(onClose).toHaveBeenCalled()
  })

  it('показывает число каналов 10-20 и предупреждения записи', () => {
    // Свое число каналов монтажа — чтобы «8» не совпало с n_channels (иначе
    // getByText не различил бы значения двух строк «Каналов» и «Каналов 10-20»).
    const channels = recordingFixture.channels.slice(0, 8)
    useEdfRecording.setState({
      recording: {
        ...recordingFixture,
        channels,
        warnings: ['2 канала без позиций пропущены'],
      },
      passport: { ...EMPTY_PASSPORT },
    })
    renderWithProviders(<SessionPassportDialog open onClose={vi.fn()} />)

    expect(screen.getByText('Каналов 10-20')).toBeInTheDocument()
    expect(screen.getByText(String(channels.length))).toBeInTheDocument()
    expect(screen.getByText('2 канала без позиций пропущены')).toBeInTheDocument()
  })

  it('единицы для БД правятся в черновике и сохраняются без запросов', async () => {
    const user = userEvent.setup()
    renderWithProviders(<SessionPassportDialog open onClose={vi.fn()} />)

    await user.selectOptions(screen.getByLabelText('Единицы в БД'), 'uV')

    // До сохранения стор не тронут: правка идёт в черновик
    expect(useEdfRecording.getState().passport.units).toBe('auto')

    await user.click(screen.getByRole('button', { name: 'Сохранить' }))
    expect(useEdfRecording.getState().passport.units).toBe('uV')
  })

  it('«Отмена» и Esc закрывают диалог без записи в стор', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderWithProviders(<SessionPassportDialog open onClose={onClose} />)

    await user.type(screen.getByLabelText('Сессия'), 'черновик')
    await user.click(screen.getByRole('button', { name: 'Отмена' }))

    expect(useEdfRecording.getState().passport.title).toBe('')
    expect(onClose).toHaveBeenCalledTimes(1)

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(useEdfRecording.getState().passport.title).toBe('')
  })

  it('помечает повторную загрузку: открыта существующая запись, копии нет', () => {
    useEdfRecording.setState({
      recording: { ...recordingFixture, deduplicated: true },
      passport: { ...EMPTY_PASSPORT },
    })
    renderWithProviders(<SessionPassportDialog open onClose={vi.fn()} />)

    expect(screen.getByText(/открыта существующая запись, копия не создана/)).toBeInTheDocument()
  })

  it('не показывает пометку дедупа для новой записи', () => {
    renderWithProviders(<SessionPassportDialog open onClose={vi.fn()} />)

    expect(screen.queryByText(/копия не создана/)).not.toBeInTheDocument()
  })

  it('показывает, что запись не загружена, если паспорт открыт без неё', () => {
    useEdfRecording.setState({ recording: null, passport: { ...EMPTY_PASSPORT } })
    renderWithProviders(<SessionPassportDialog open onClose={vi.fn()} />)

    expect(screen.getByText('не загружен')).toBeInTheDocument()
  })
})
