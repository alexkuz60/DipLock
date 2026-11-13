/**
 * Действия выборки раздела «БД»: передача выбранных записей в пару/группу
 * «Группового анализа» (сторы `groupCompare`/`groupRun`).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useGroupCompare } from '@/shared/state/groupCompare'
import { useGroupRun } from '@/shared/state/groupRun'
import { sendSelectionToGroup, sendSelectionToPair } from './dbActions'

describe('dbActions: выборка → пара/группа', () => {
  beforeEach(() => {
    useGroupCompare.setState({ recordingIdA: null, recordingIdB: null })
    useGroupRun.setState({ recordingIds: [], mode: 'pair' })
  })

  it('пара: A — первая выбранная, B — вторая; не ровно 2 — отказ', () => {
    expect(sendSelectionToPair(['rec-a', 'rec-b'])).toBe(true)
    expect(useGroupCompare.getState().recordingIdA).toBe('rec-a')
    expect(useGroupCompare.getState().recordingIdB).toBe('rec-b')
    expect(useGroupRun.getState().mode).toBe('pair')

    expect(sendSelectionToPair(['rec-a'])).toBe(false)
    expect(sendSelectionToPair(['a', 'b', 'c'])).toBe(false)
  })

  it('группа: участники в порядке выбора, режим «группа»; меньше 2 — отказ', () => {
    expect(sendSelectionToGroup(['rec-b', 'rec-a', 'rec-c'])).toBe(true)
    expect(useGroupRun.getState().recordingIds).toEqual(['rec-b', 'rec-a', 'rec-c'])
    expect(useGroupRun.getState().mode).toBe('group')

    expect(sendSelectionToGroup(['rec-a'])).toBe(false)
  })

  it('группа дедуплицирует повторы, сохраняя порядок', () => {
    expect(sendSelectionToGroup(['rec-a', 'rec-b', 'rec-a'])).toBe(true)
    expect(useGroupRun.getState().recordingIds).toEqual(['rec-a', 'rec-b'])
  })
})