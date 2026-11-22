/**
 * Вложения нити чата: прикрепление документа библиотеки и снятие вложения.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentAttachments } from './AgentAttachments'
import { mockApiFetch } from '@/test/apiMocks'
import { agentAttachmentFixture } from '@/test/fixtures'
import { renderWithProviders } from '@/test/renderWithProviders'

afterEach(() => vi.unstubAllGlobals())

describe('AgentAttachments', () => {
  it('прикрепляет документ библиотеки и отправляет подпись', async () => {
    const fetchMock = mockApiFetch()
    renderWithProviders(<AgentAttachments threadId="t-1" />)

    expect(await screen.findByText(/Вложения нити \(0\)/)).toBeInTheDocument()
    expect(screen.getByText(/уходят провайдеру/)).toBeInTheDocument()

    fireEvent.change(await screen.findByLabelText('Что прикрепить'), {
      target: { value: 'k-1' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Прикрепить' }))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([input, init]) =>
          String(input).includes('/knowledge/threads/t-1/attachments') &&
          init?.method === 'POST',
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        kind: 'document',
        ref_id: 'k-1',
        label: 'Бета-активность в височной области',
      })
    })
  })

  it('снимает вложение одним кликом', async () => {
    const fetchMock = mockApiFetch({
      agentAttachments: { items: [agentAttachmentFixture()] },
    })
    renderWithProviders(<AgentAttachments threadId="t-1" />)

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Снять вложение Бета-активность в височной области',
      }),
    )

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([input, init]) =>
            String(input).includes('/knowledge/attachments/att-1') &&
            init?.method === 'DELETE',
        ),
      ).toBe(true),
    )
  })
})
