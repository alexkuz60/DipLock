/**
 * Действия выборки раздела «БД»: передача выбранных записей в пару/группу
 * «Группового анализа» (сторы `groupCompare`/`groupRun`).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { useDbView } from '@/shared/state/dbView'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { useGroupCompare } from '@/shared/state/groupCompare'
import { useGroupRun } from '@/shared/state/groupRun'
import { mockApiFetch } from '@/test/apiMocks'
import { recordingFixture } from '@/test/fixtures'
import { deleteRecordings, sendSelectionToGroup, sendSelectionToPair } from './dbActions'

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

describe('dbActions: удаление выбранных записей', () => {
  beforeEach(() => {
    useDbView.setState({ selectedIds: [] })
    useEdfRecording.setState({ recording: null })
  })

  it('удаляет записи каскадом и закрывает открытую, если она удалена', async () => {
    const fetchSpy = mockApiFetch()
    useEdfRecording.setState({ recording: recordingFixture })

    const result = await deleteRecordings([recordingFixture.recording_id, 'rec-b'])

    expect(result.deleted).toEqual([recordingFixture.recording_id, 'rec-b'])
    expect(result.failed).toEqual([])
    // DELETE — по одной записи (каскад: файл, кэши, строки БД)
    const deletes = fetchSpy.mock.calls.filter(
      ([, init]) => (init as RequestInit | undefined)?.method === 'DELETE',
    )
    expect(deletes).toHaveLength(2)
    // Открытая запись среди удалённых закрыта: её файла и кэшей больше нет
    expect(useEdfRecording.getState().recording).toBeNull()
  })

  it('отказ одной записи не мешает остальным и несёт текст ошибки', async () => {
    mockApiFetch({ deleteRecordingFails: { 'rec-b': 'Запись занята' } })
    useEdfRecording.setState({ recording: recordingFixture })

    const result = await deleteRecordings(['rec-b', 'rec-c'])

    expect(result.deleted).toEqual(['rec-c'])
    expect(result.failed).toEqual([{ recordingId: 'rec-b', error: 'Запись занята' }])
    // Открытая запись не входит в удалённые — остаётся открытой
    expect(useEdfRecording.getState().recording).not.toBeNull()
  })
})