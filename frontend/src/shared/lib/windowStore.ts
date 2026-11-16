/**
 * Окно времени вьюера как внешний стор.
 *
 * Панорама меняет окно каждый кадр rAF. Пока окно шло пропом строки, `memo` на
 * `TrackRow` не пропускал ни одной строки (`docs/rules/frontend-perf.md`):
 * подписка позволяет перерисовывать только чарт со слоями, минуя React-работу
 * подписи канала и кнопок.
 */
import type { TimeWindow } from './viewerMath'

export type ViewerWindowStore = {
  get: () => TimeWindow
  set: (window: TimeWindow) => void
  subscribe: (listener: () => void) => () => void
}

export function createWindowStore(initial: TimeWindow): ViewerWindowStore {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set: (next) => {
      if (next.t0 === current.t0 && next.t1 === current.t1) return
      current = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
