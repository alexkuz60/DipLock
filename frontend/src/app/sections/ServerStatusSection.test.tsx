/** Тесты раздела «Состояние сервера»: проверки, версии, пути, ошибка сервера. */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ServerStatusSection } from './ServerStatusSection'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'

describe('раздел «Состояние сервера»', () => {
  it('показывает проверки компонентов с человекочитаемыми названиями', async () => {
    mockApiFetch()
    renderWithProviders(<ServerStatusSection />)

    expect(await screen.findByText('MNE-Python')).toBeInTheDocument()
    expect(screen.getByText('База данных')).toBeInTheDocument()
    expect(screen.getByText('Данные FSAverage')).toBeInTheDocument()
    expect(screen.getByText('Transform (MRI ↔ head)')).toBeInTheDocument()
    expect(screen.getByText('BEM-модель головы')).toBeInTheDocument()

    // статус transform в фикстуре — error
    expect(screen.getByText('требуется внимание')).toBeInTheDocument()
  })

  it('показывает версии библиотек и пути данных', async () => {
    mockApiFetch()
    renderWithProviders(<ServerStatusSection />)

    expect(await screen.findByText('1.13.2')).toBeInTheDocument()
    expect(screen.getByText('3.12.3')).toBeInTheDocument()
    expect(screen.getByText('/home/user/DipLock/data/cache')).toBeInTheDocument()
    expect(screen.getByText('/api/v1/meta')).toBeInTheDocument()
  })

  it('показывает параметры расчёта из /meta', async () => {
    mockApiFetch()
    renderWithProviders(<ServerStatusSection />)

    expect(await screen.findByText('Параметры расчёта')).toBeInTheDocument()
    expect(screen.getByText('150')).toBeInTheDocument() // reject, мкВ
    expect(screen.getByText('abc123def456')).toBeInTheDocument() // surface version
  })

  it('сообщает об ошибке и предлагает повторить запрос', async () => {
    mockApiFetch({ initStatusFails: true })
    renderWithProviders(<ServerStatusSection />)

    expect(await screen.findByText(/Сервер не отвечает на \/init-status/)).toBeInTheDocument()
    expect(screen.getByText('Сервис недоступен')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Повторить/ })).toBeInTheDocument()
  })
})
