/** Тесты раздела «Состояние сервера»: проверки, версии, пути, ошибка сервера, перезапуск. */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ServerStatusSection } from './ServerStatusSection'
import { mockApiFetch } from '@/test/apiMocks'
import type { InitStatus } from '@/shared/api/types'
import { initStatusFixture } from '@/test/fixtures'
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

  it('показывает занятость кэша записей с квотой (N40/4.6)', async () => {
    mockApiFetch()
    renderWithProviders(<ServerStatusSection />)

    const cache = await screen.findByTestId('cache-usage')
    // фикстура: 12.5 МБ из 256 МБ (квота), единиц 3
    expect(cache).toHaveTextContent('12.5 МБ из 256.0 МБ (квота) · единиц: 3')
  })

  it('кэш, который сервер не посчитал (−1), показывается прочерком, а не нулём', async () => {
    mockApiFetch({
      initStatus: {
        ...initStatusFixture,
        cache: { usage_bytes: -1, units: -1, quota_bytes: -1 },
      },
    })
    renderWithProviders(<ServerStatusSection />)

    const cache = await screen.findByTestId('cache-usage')
    expect(cache).toHaveTextContent('— (не посчиталось)')
  })

  it('ответ без поля cache (бэкенд до N40) — подсказка, а не краш раздела', async () => {
    // Регрессия 04.10.2026: свежий бандл + старый процесс → data.cache is
    // undefined и React падал в ServerStatusSection. Поля в ответе может не быть.
    const withoutCache: InitStatus = { ...initStatusFixture }
    delete withoutCache.cache
    mockApiFetch({ initStatus: withoutCache })
    renderWithProviders(<ServerStatusSection />)

    const cache = await screen.findByTestId('cache-usage')
    expect(cache).toHaveTextContent('— (бэкенд не отчитался: перезапустите сервер)')
    // Раздел жив: остальные блоки на месте
    expect(screen.getByText('Параметры расчёта')).toBeInTheDocument()
  })

  it('показывает параметры расчёта из /meta', async () => {
    mockApiFetch()
    renderWithProviders(<ServerStatusSection />)

    expect(await screen.findByText('Параметры расчёта')).toBeInTheDocument()
    expect(screen.getByText('abc123def456')).toBeInTheDocument() // surface version
  })

  it('сообщает об ошибке и предлагает повторить запрос', async () => {
    mockApiFetch({ initStatusFails: true })
    renderWithProviders(<ServerStatusSection />)

    expect(await screen.findByText(/Сервер не отвечает на \/init-status/)).toBeInTheDocument()
    expect(screen.getByText('Сервис недоступен')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Повторить/ })).toBeInTheDocument()
  })

  it('показывает свежесть кода бэкенда', async () => {
    mockApiFetch()
    renderWithProviders(<ServerStatusSection />)

    expect(await screen.findByText(/свежий \(2026-09-24T12:00:00\)/)).toBeInTheDocument()
  })

  it('предупреждает, когда бэкенд не обновлён (код новее сервера)', async () => {
    mockApiFetch({
      initStatus: {
        ...initStatusFixture,
        code: { ...initStatusFixture.code, stale: true },
      },
    })
    renderWithProviders(<ServerStatusSection />)

    expect(await screen.findByText(/устарел — код новее сервера/)).toBeInTheDocument()
    expect(screen.getByText(/перезапустите его кнопкой ниже/i)).toBeInTheDocument()
    expect(screen.getByText(/пересчитайте запись/i)).toBeInTheDocument()
  })

  it('кнопка перезапуска: подтверждение → 202 → ожидание нового процесса', async () => {
    const fetchMock = mockApiFetch()
    renderWithProviders(<ServerStatusSection />)
    await screen.findByText('MNE-Python')

    // Первый клик — подтверждение с числом активных задач (в моке их 0)
    await userEvent.click(screen.getByRole('button', { name: /Перезапустить бэкенд/ }))
    expect(await screen.findByText(/Активных задач: 0/)).toBeInTheDocument()

    // Подтверждение: POST /server/restart → 202 → фаза ожидания
    await userEvent.click(screen.getByRole('button', { name: /Да, перезапустить/ }))
    expect(await screen.findByText(/Перезапускаем бэкенд/)).toBeInTheDocument()
    const postUrls = fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
      .map(([url]) => String(url))
    expect(postUrls.some((url) => url.includes('/server/restart'))).toBe(true)
  })

  it('отказ перезапуска (409) показывает текст сервера', async () => {
    mockApiFetch({
      restartFail: 'Сервер запущен в dev-режиме с --reload — перезапуск из UI не нужен',
    })
    renderWithProviders(<ServerStatusSection />)
    await screen.findByText('MNE-Python')

    await userEvent.click(screen.getByRole('button', { name: /Перезапустить бэкенд/ }))
    await userEvent.click(screen.getByRole('button', { name: /Да, перезапустить/ }))

    expect(
      await screen.findByText(/dev-режиме с --reload — перезапуск из UI не нужен/),
    ).toBeInTheDocument()
    // отказ не закрывает подтверждение: можно отмениться или повторить
    expect(screen.getByRole('button', { name: /Да, перезапустить/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Отмена/ })).toBeInTheDocument()
  })

  it('кнопка отмены возвращает в исходное состояние без POST', async () => {
    const fetchMock = mockApiFetch()
    renderWithProviders(<ServerStatusSection />)
    await screen.findByText('MNE-Python')

    await userEvent.click(screen.getByRole('button', { name: /Перезапустить бэкенд/ }))
    await userEvent.click(screen.getByRole('button', { name: /Отмена/ }))

    expect(screen.getByRole('button', { name: /Перезапустить бэкенд/ })).toBeInTheDocument()
    const postUrls = fetchMock.mock.calls
      .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
      .map(([url]) => String(url))
    expect(postUrls.some((url) => url.includes('/server/restart'))).toBe(false)
  })
})
