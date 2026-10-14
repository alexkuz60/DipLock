/**
 * Живой стрим событий раунда (срез 0011): наложение дельт и подписка на SSE.
 *
 * Поздние события чужого запуска состояние не трогают; обрыв потока не ошибка —
 * клиент остаётся на поллинге.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  applyStreamEvent,
  emptyLiveRound,
  subscribeRoundStream,
  type LiveRound,
} from '@/shared/lib/roundStream'
import type { ConsiliumStreamEvent } from '@/shared/api/types'

function event(changes: Partial<ConsiliumStreamEvent>): ConsiliumStreamEvent {
  return { type: 'delta', role: null, delta: null, model: null, status: null, error: null, ...changes }
}

describe('applyStreamEvent', () => {
  it('складывает дельты роли и меняет статус по границам', () => {
    let live: LiveRound | null = null
    live = applyStreamEvent(live, 'round-1', event({ type: 'role_started', role: 'psychological', status: 'streaming' }))
    live = applyStreamEvent(live, 'round-1', event({ type: 'delta', role: 'psychological', delta: 'При' }))
    live = applyStreamEvent(live, 'round-1', event({ type: 'delta', role: 'psychological', delta: ' вет' }))

    expect(live?.roles.psychological?.text).toBe('При вет')
    expect(live?.roles.psychological?.status).toBe('streaming')
    expect(live?.finished).toBe(false)

    live = applyStreamEvent(live, 'round-1', event({
      type: 'role_done', role: 'psychological', status: 'done', model: 'prov/model-x',
    }))
    expect(live?.roles.psychological?.status).toBe('done')
    expect(live?.roles.psychological?.model).toBe('prov/model-x')

    live = applyStreamEvent(live, 'round-1', event({ type: 'round_done' }))
    expect(live?.finished).toBe(true)
  })

  it('поздние события чужого раунда состояние не трогают', () => {
    const live = applyStreamEvent(
      emptyLiveRound('round-1'),
      'round-2',
      event({ type: 'delta', role: 'psychological', delta: 'чужой текст' }),
    )

    expect(live?.roundId).toBe('round-1')
    expect(live?.roles.psychological).toBeUndefined()
  })

  it('роль может завершиться честным отказом', () => {
    let live: LiveRound | null = emptyLiveRound('round-1')
    live = applyStreamEvent(live, 'round-1', event({
      type: 'role_done', role: 'methodological', status: 'failed', error: 'Сеть недоступна',
    }))

    expect(live?.roles.methodological?.status).toBe('failed')
    expect(live?.roles.methodological?.error).toBe('Сеть недоступна')
  })
})

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

describe('subscribeRoundStream', () => {
  it('разбирает SSE-фреймы в события и закрывается по концу потока', async () => {
    const urls: string[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return sseResponse([
        'event: delta\ndata: {"type":"delta","role":"psychological","delta":"Привет"}\n\n',
        'event: round_done\ndata: {"type":"round_done"}\n\n',
      ])
    })
    vi.stubGlobal('fetch', fetchMock)
    const seen: ConsiliumStreamEvent[] = []
    await new Promise<void>((resolve) => {
      subscribeRoundStream('case-a', 'round-1', (item) => seen.push(item), undefined)
      // Поток отдаёт все фреймы сразу и закрывается — события видны через тик
      setTimeout(resolve, 0)
    })
    vi.unstubAllGlobals()

    expect(urls[0]).toContain('/rounds/round-1/stream')
    expect(seen.map((item) => item.type)).toEqual(['delta', 'round_done'])
    expect(seen[0].delta).toBe('Привет')
  })

  it('обрыв потока — честный onError, клиент остаётся на поллинге', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('нет', { status: 500 })))
    const onError = vi.fn()
    await new Promise<void>((resolve) => {
      subscribeRoundStream('case-a', 'round-1', () => {}, onError)
      setTimeout(resolve, 0)
    })
    vi.unstubAllGlobals()

    expect(onError).toHaveBeenCalledTimes(1)
  })
})