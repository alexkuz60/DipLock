/**
 * Тесты чистых слоёв вьюера (срез 2.6): сетка эпох, видимость зон, подписи
 * и детерминированная фикстура артефактов.
 *
 * Слои — обычная арифметика поверх параметров, поэтому проверяются без DOM:
 * рендер зон/штриховки вынесен в `TrackLayers.test.tsx`, вьюер целиком — в
 * `viewer/TrackStack.test.tsx`.
 */
import { describe, expect, it } from 'vitest'
import { ARTIFACT_KINDS } from '@/shared/lib/artifacts'
import {
  MAX_EPOCH_CELLS,
  artifactCounts,
  artifactZoneText,
  buildEpochCells,
  cellAtTime,
  demoLayers,
  epochFramesForChannel,
  epochMarkTitle,
  epochRejectReason,
  eventMarks,
  formatSecondsRange,
  gridEpochLength,
  isEpochBlocked,
  manualVerdict,
  toggleEpochMark,
  visibleZones,
  type ArtifactZone,
  type EdfViewerLayers,
  zonesForChannel,
} from '@/shared/lib/viewerLayers'

const VISIBLE_ALL = {
  zscore_outlier: true,
  peak_to_peak: true,
  flat_line: true,
  clipping: true,
  break: true,
  electrode_pop: true,
  muscle_emg: true,
  line_noise: true,
  ocular: true,
  ecg: true,
  ica_eog: true,
}

function zone(overrides: Partial<ArtifactZone> = {}): ArtifactZone {
  return {
    id: 'zscore_outlier-1',
    kind: 'zscore_outlier',
    onsetSec: 1.25,
    durationSec: 0.5,
    channels: ['F3', 'C3'],
    ...overrides,
  }
}

describe('сетка эпох', () => {
  it('покрывает запись подряд, хвост последней эпохи короче', () => {
    const cells = buildEpochCells(5, 2000)

    expect(cells.map((cell) => cell.onsetSec)).toEqual([0, 2, 4])
    expect(cells.map((cell) => cell.durationSec)).toEqual([2, 2, 1])
    expect(cells.map((cell) => cell.index)).toEqual([0, 1, 2])
  })

  it('делит ровную длину без «лишней» эпохи из-за погрешности float', () => {
    const cells = buildEpochCells(30, 2000)
    expect(cells).toHaveLength(15)
    expect(cells.at(-1)?.durationSec).toBe(2)
  })

  it('помечает отброшенные эпохи, не меняя геометрию', () => {
    const cells = buildEpochCells(10, 2000, [0, 3, 99])

    expect(cells.map((cell) => cell.rejected)).toEqual([true, false, false, true, false])
  })

  it('пустая или нулевая сессия не даёт эпох', () => {
    expect(buildEpochCells(0, 2000)).toEqual([])
    expect(buildEpochCells(-5, 2000)).toEqual([])
  })

  it('вырожденные параметры не раздувают сетку', () => {
    // 0.5 мс на 10 минут = 1.2 млн эпох: потолок обязателен
    expect(buildEpochCells(600, 0.5)).toHaveLength(MAX_EPOCH_CELLS)
    expect(buildEpochCells(600, 0)).toHaveLength(MAX_EPOCH_CELLS)
  })

  it('раскладывает ручные пометки по сетке пересечением', () => {
    // Пометка «1.0–2.0 с» накрывает эпохи 2 и 3 сетки 500 мс
    const marks = [{ onsetSec: 1, durationSec: 1, blocked: true }]
    const cells = buildEpochCells(3, 500, [], marks)

    expect(cells.map((cell) => cell.manual)).toEqual([
      null,
      null,
      'blocked',
      'blocked',
      null,
      null,
    ])
    // Вердикт алгоритма пометки не подменяет: rejected остаётся нулевым
    expect(cells.some((cell) => cell.rejected)).toBe(false)
  })
})

describe('нарезка эпох и ручные пометки (срез 2.10)', () => {
  it('gridEpochLength берёт длину из результата, у фикстуры — параметр панели', () => {
    const result: EdfViewerLayers = {
      artifacts: [],
      rejectedEpochs: [],
      rejectChannels: {},
      epochLengthMs: 2000,
      source: 'result',
    }
    expect(gridEpochLength(result, 500)).toBe(2000)
    // Результат без длины (пустая стадия) — сетка по параметру
    expect(gridEpochLength({ ...result, epochLengthMs: null }, 500)).toBe(500)
    // Демо-фикстура ни к какому расчёту не привязана
    expect(gridEpochLength({ ...result, epochLengthMs: 2000, source: 'demo' }, 500)).toBe(500)
  })

  it('штриховка остаётся на своём участке записи при смене длины эпохи', () => {
    // Результат нарезан по 2000 мс, отброшена эпоха 4 (8–10 с)
    const layers: EdfViewerLayers = {
      artifacts: [],
      rejectedEpochs: [4],
      rejectChannels: { 4: ['F3'] },
      epochLengthMs: 2000,
      source: 'result',
    }
    const length = gridEpochLength(layers, 250)
    const cells = buildEpochCells(30, length, layers.rejectedEpochs)

    const rejected = cells.filter((cell) => cell.rejected)
    expect(rejected).toHaveLength(1)
    // Тот же участок таймлайна, а не «пятая эпоха» новой сетки
    expect([rejected[0]!.onsetSec, rejected[0]!.durationSec]).toEqual([8, 2])
    expect(rejected[0]!.index).toBe(4)
  })

  it('toggleEpochMark блокирует эпоху, принятую алгоритмом, и снимает правку', () => {
    const interval = { onsetSec: 2, durationSec: 0.5 }

    const blocked = toggleEpochMark([], interval, false)
    expect(blocked).toEqual([{ onsetSec: 2, durationSec: 0.5, blocked: true }])
    expect(manualVerdict(blocked, interval)).toBe('blocked')
    expect(isEpochBlocked(false, manualVerdict(blocked, interval))).toBe(true)

    // Повторный Ctrl+двойной клик возвращает вердикт алгоритма
    expect(toggleEpochMark(blocked, interval, false)).toEqual([])
  })

  it('toggleEpochMark снимает блокировку reject-фильтра и ставит её обратно', () => {
    const interval = { onsetSec: 0, durationSec: 2 }

    const allowed = toggleEpochMark([], interval, true)
    expect(allowed).toEqual([{ onsetSec: 0, durationSec: 2, blocked: false }])
    expect(isEpochBlocked(true, manualVerdict(allowed, interval))).toBe(false)

    // «Включение» блокировки у отброшенной эпохи — это просто снятие ручной правки
    expect(toggleEpochMark(allowed, interval, true)).toEqual([])
  })

  it('правка одной эпохи не стирает пометки соседних', () => {
    const marks = toggleEpochMark([], { onsetSec: 0, durationSec: 4 }, false)
    // Внутри заблокированного блока разблокируем центральную секунду
    const after = toggleEpochMark(marks, { onsetSec: 1, durationSec: 1 }, false)

    // Края прежней пометки остались: снята только вырезанная часть
    expect(after).toEqual([
      { onsetSec: 0, durationSec: 1, blocked: true },
      { onsetSec: 2, durationSec: 2, blocked: true },
    ])
    expect(manualVerdict(after, { onsetSec: 0, durationSec: 1 })).toBe('blocked')
    expect(manualVerdict(after, { onsetSec: 1, durationSec: 1 })).toBeNull()
    expect(manualVerdict(after, { onsetSec: 3, durationSec: 1 })).toBe('blocked')
  })

  it('cellAtTime находит эпоху под курсором, включая хвост последней', () => {
    const cells = buildEpochCells(5, 2000) // эпохи 0–2 с и 2–4 с и хвост 4–5 с

    expect(cellAtTime(cells, 0)?.index).toBe(0)
    expect(cellAtTime(cells, 1.999)?.index).toBe(0)
    expect(cellAtTime(cells, 2)?.index).toBe(1)
    expect(cellAtTime(cells, 5)?.index).toBe(2)
    expect(cellAtTime(cells, 5.5)).toBeNull()
    expect(cellAtTime([], 1)).toBeNull()
  })
})

describe('видимость и подписи зон', () => {
  const zones = [
    zone(),
    zone({ id: 'flat_line-1', kind: 'flat_line', onsetSec: 3, durationSec: 0.25 }),
    zone({ id: 'ica_eog-1', kind: 'ica_eog', onsetSec: 5, durationSec: 2, channels: [] }),
  ]

  it('visibleZones убирает выключенные в легенде типы', () => {
    const visible = visibleZones(zones, {
      ...VISIBLE_ALL,
      flat_line: false,
      ica_eog: false,
    })
    expect(visible.map((item) => item.id)).toEqual(['zscore_outlier-1'])
  })

  it('отсутствующий в настройках тип считается видимым (старый localStorage)', () => {
    const visible = visibleZones(zones, {} as Record<ArtifactZone['kind'], boolean>)
    expect(visible).toHaveLength(3)
  })

  it('подпись зоны содержит тип, интервал и каналы', () => {
    expect(artifactZoneText(zone())).toBe('z-score выбросы: 1.250–1.750 с · каналы: F3, C3')
    expect(artifactZoneText(zones[2]!)).toContain('каналы: весь монтаж')
    expect(formatSecondsRange(0, 0.4)).toBe('0.000–0.400 с')
  })

  it('artifactCounts считает зоны по типам, включая нули', () => {
    expect(artifactCounts(zones)).toEqual({
      zscore_outlier: 1,
      peak_to_peak: 0,
      flat_line: 1,
      clipping: 0,
      break: 0,
      electrode_pop: 0,
      muscle_emg: 0,
      line_noise: 0,
      ocular: 0,
      ecg: 0,
      ica_eog: 1,
    })
  })
})

describe('фикстура слоёв', () => {
  it('детерминирована: одинаковый вход — одинаковые зоны', () => {
    const first = demoLayers(120, ['F3', 'F4'])
    const second = demoLayers(120, ['F3', 'F4'])
    expect(second).toEqual(first)
    expect(first.source).toBe('demo')
  })

  it('даёт 2–4 зоны каждого типа и все — внутри записи', () => {
    const { artifacts } = demoLayers(120, ['F3', 'F4', 'C3'])

    for (const kind of ARTIFACT_KINDS) {
      const ofKind = artifacts.filter((item) => item.kind === kind)
      // У ICA зоны не бывает вовсе: компоненты не привязаны ко времени (24.09.2026)
      if (kind === 'ica_eog') {
        expect(ofKind).toHaveLength(0)
        continue
      }
      expect(ofKind.length).toBeGreaterThanOrEqual(2)
      expect(ofKind.length).toBeLessThanOrEqual(4)
    }
    for (const item of artifacts) {
      expect(item.onsetSec).toBeGreaterThanOrEqual(0)
      expect(item.onsetSec + item.durationSec).toBeLessThanOrEqual(120.0001)
      expect(item.durationSec).toBeGreaterThan(0)
      expect(item.channels.length).toBeGreaterThan(0)
    }
  })

  it('сетевой шум бьёт по всему монтажу, остальные — по подмножеству', () => {
    const channels = ['F3', 'F4', 'C3', 'C4']
    const { artifacts } = demoLayers(60, channels)

    // Зон ICA нет вовсе (компоненты не привязаны ко времени — фидбэк 24.09.2026)
    expect(artifacts.some((item) => item.kind === 'ica_eog')).toBe(false)
    for (const item of artifacts.filter((zone) => zone.kind === 'line_noise')) {
      expect(item.channels).toEqual(channels)
    }
    for (const item of artifacts.filter((zone) => zone.kind !== 'line_noise')) {
      expect(item.channels.length).toBeLessThanOrEqual(3)
      for (const name of item.channels) expect(channels).toContain(name)
    }
  })

  it('эпохи-отбросы непусты и лежат в пределах записи', () => {
    const { rejectedEpochs } = demoLayers(60, ['F3'])
    expect(rejectedEpochs.length).toBeGreaterThan(0)
    for (const index of rejectedEpochs) {
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(30)
    }
  })

  it('эпохи-отбросы несут каналы-виновники', () => {
    const { rejectedEpochs, rejectChannels } = demoLayers(60, ['F3'])
    expect(Object.keys(rejectChannels).map(Number)).toEqual([...rejectedEpochs].sort((a, b) => a - b))
    for (const names of Object.values(rejectChannels)) {
      for (const name of names) expect(['F3', 'F4']).toContain(name)
    }
  })

  it('короткая запись не даёт зон за границей (нулевая длительность тоже)', () => {
    const { artifacts, rejectedEpochs } = demoLayers(0.5, [])
    for (const item of artifacts) {
      expect(item.onsetSec + item.durationSec).toBeLessThanOrEqual(0.5001)
    }
    expect(rejectedEpochs).toEqual([0])
  })
})

describe('зоны развёрнутого трека по каналу (срез 5, п. 4)', () => {
  const zones: ArtifactZone[] = [
    { id: 'z-1', kind: 'zscore_outlier', onsetSec: 1, durationSec: 1, channels: ['F3'] },
    { id: 'z-2', kind: 'flat_line', onsetSec: 5, durationSec: 0.5, channels: ['C3', 'F4'] },
    { id: 'z-3', kind: 'ica_eog', onsetSec: 2, durationSec: 0.5, channels: [] },
  ]

  it('пустой список каналов — зона всего монтажа и попадает на любой трек', () => {
    expect(zonesForChannel(zones, 'F3').map((zone) => zone.id)).toEqual(['z-1', 'z-3'])
    expect(zonesForChannel(zones, 'F4').map((zone) => zone.id)).toEqual(['z-2', 'z-3'])
  })

  it('зона чужого канала на трек не попадает', () => {
    expect(zonesForChannel(zones, 'Fp1').map((zone) => zone.id)).toEqual(['z-3'])
    expect(zonesForChannel([], 'F3')).toEqual([])
  })
})

describe('причины и каналы блокировки эпох', () => {
  const cells = buildEpochCells(10, 2000, [1], [], { 1: ['F3', 'C3'] })

  it('buildEpochCells привязывает каналы-виновники к отброшенным эпохам', () => {
    expect(cells[1]!.rejectChannels).toEqual(['F3', 'C3'])
    // Не отбрасывалась — каналов нет (null), а не пустой список
    expect(cells[0]!.rejectChannels).toBeNull()
    // Эпоха отброшена, но в слое нет каналов — «виновник не определён», эпоха не теряется
    const tail = buildEpochCells(10, 2000, [1, 4], [], { 1: ['F3'] })
    expect(tail[4]!.rejectChannels).toEqual([])
  })

  it('причина reject-фильтра называет каналы, без канала — «обнаружен артефакт»', () => {
    expect(epochRejectReason(cells[1]!)).toBe('каналы: F3, C3')
    expect(epochRejectReason({ ...cells[4]!, rejected: true, rejectChannels: [] })).toBe(
      'обнаружен артефакт (детектор)',
    )
  })

  it('тултип эпохи — вердикт, причина и подсказка жеста', () => {
    expect(epochMarkTitle(cells[1]!)).toBe(
      'Эпоха 2: 2.000–4.000 с — не в расчёте (каналы: F3, C3) · клик снимает правку',
    )
    expect(epochMarkTitle(cells[0]!)).toBe(
      'Эпоха 1: 0.000–2.000 с — в расчёте · клик блокирует',
    )
    // Ручная правка называет себя: снятая блокировка и поставленная вручную
    const restored = buildEpochCells(10, 2000, [1], [{ onsetSec: 2, durationSec: 2, blocked: false }], {
      1: ['F3'],
    })
    expect(epochMarkTitle(restored[1]!)).toBe(
      'Эпоха 2: 2.000–4.000 с — в расчёте (блокировка снята вручную) · клик блокирует',
    )
    const handBlocked = buildEpochCells(10, 2000, [], [
      { onsetSec: 0, durationSec: 2, blocked: true },
    ])
    expect(epochMarkTitle(handBlocked[0]!)).toBe(
      'Эпоха 1: 0.000–2.000 с — не в расчёте (заблокирована вручную) · клик снимает правку',
    )
  })

  it('рамки достаются трекам каналов-виновников, чужие и разблокированные не попадают', () => {
    expect(epochFramesForChannel(cells, 'F3').map((cell) => cell.index)).toEqual([1])
    expect(epochFramesForChannel(cells, 'C3').map((cell) => cell.index)).toEqual([1])
    expect(epochFramesForChannel(cells, 'Fp1')).toEqual([])
    // Снятая вручную блокировка рамки не оставляет: эпоха вернулась в расчёт
    const released = buildEpochCells(10, 2000, [1], [{ onsetSec: 2, durationSec: 2, blocked: false }], {
      1: ['F3'],
    })
    expect(epochFramesForChannel(released, 'F3')).toEqual([])
  })
})

describe('событийная нарезка и слой событий (N2/2.7)', () => {
  it('buildEpochCells с явными началами строит нерегулярную сетку', () => {
    // События в 0.5, 2.0 и 5.0 с: окна шириной 1 с не делят запись поровну
    const cells = buildEpochCells(10, 1000, [1], [], {}, [0.5, 2.0, 5.0])

    expect(cells.map((cell) => cell.onsetSec)).toEqual([0.5, 2.0, 5.0])
    expect(cells.map((cell) => cell.durationSec)).toEqual([1, 1, 1])
    expect(cells.map((cell) => cell.rejected)).toEqual([false, true, false])
    // Индексы отброшенных живут в порядке событий, а не регулярных ячеек
    expect(cells[1]?.rejectChannels).toEqual([])
  })

  it('сетка с началами обрезается по краю записи', () => {
    const cells = buildEpochCells(5.5, 1000, [], [], {}, [0, 2, 5])
    expect(cells[2]?.durationSec).toBe(0.5)
  })

  it('пустой список начал даёт пустую сетку', () => {
    expect(buildEpochCells(10, 1000, [], [], {}, [])).toEqual([])
  })

  it('eventMarks переводит события паспорта в слой вьюера', () => {
    const marks = eventMarks([
      { onset: 1.25, duration: 0, description: 'STIM/5', source: 'stim' },
      { onset: 3, duration: 0.5, description: 'Sound/On', source: 'annotation' },
    ])

    expect(marks).toEqual([
      { onsetSec: 1.25, durationSec: 0, description: 'STIM/5', source: 'stim' },
      { onsetSec: 3, durationSec: 0.5, description: 'Sound/On', source: 'annotation' },
    ])
  })

  it('demoLayers не несёт событийной сетки — она живёт только у результата', () => {
    const layers = demoLayers(30, ['F3'])
    expect(layers.epochStartsSec).toBeNull()
    expect(layers.eventId).toBeNull()
  })
})
