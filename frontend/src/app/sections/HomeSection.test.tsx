/** Тесты Главной: заставка, строка готовности, быстрые действия. */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { HomeSection } from './HomeSection'
import { mockApiFetch } from '@/test/apiMocks'
import { renderWithProviders } from '@/test/renderWithProviders'

describe('раздел «Главная»', () => {
  it('показывает название по центру и состояние готовности', async () => {
    mockApiFetch()
    renderWithProviders(<HomeSection />)

    expect(screen.getByRole('heading', { level: 1, name: 'DipLock' })).toBeInTheDocument()
    expect(screen.getByText('Анализ ЭЭГ и расчёт токовых диполей в 3D')).toBeInTheDocument()
    expect(await screen.findByText(/Часть компонентов не готова/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Открыть EDF/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Состояние сервера/ })).toBeInTheDocument()
  })

  it('сообщает, когда сервер недоступен', async () => {
    mockApiFetch({ initStatusFails: true })
    renderWithProviders(<HomeSection />)

    expect(await screen.findByText(/Сервер недоступен/)).toBeInTheDocument()
  })

  it('переходит в раздел EDF по кнопке', async () => {
    const user = userEvent.setup()
    mockApiFetch()

    renderWithProviders(
      <Routes>
        <Route path="/" element={<HomeSection />} />
        <Route path="/edf" element={<div>EDF-раздел открыт</div>} />
      </Routes>,
    )

    await user.click(screen.getByRole('button', { name: /Открыть EDF/ }))

    expect(await screen.findByText('EDF-раздел открыт')).toBeInTheDocument()
  })
})
