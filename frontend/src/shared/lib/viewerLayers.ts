/**
 * Слои результата во вьюере треков (срез 2.6): зоны артефактов и эпохи.
 *
 * Слои — это результат предподготовки, а не сигнал: вьюер рисует их поверх треков
 * и не участвует в расчёте. Срез 2.6 берёт их из **детерминированной фикстуры**
 * (`demoLayers`), пока стадии `artifacts`/`epochs` не подключены к серверу
 * (срез 2.7): так отрисовка, легенда и тултипы проверяются без бэкенда, а
 * `source: 'demo'` явно помечает данные как ненастоящие.
 *
 * Границы эпох, в отличие от отброшенных эпох, считаются из параметра
 * «длина эпохи» (`buildEpochCells`): это геометрия по параметру, а не результат
 * обработки, поэтому сетка вьюера живая уже сейчас.
 *
 * Модуль чистый (без DOM и zustand) — вся арифметика слоёв покрыта тестами.
 */
import { ARTIFACT_KINDS, ARTIFACT_LABELS, type ArtifactKind } from './artifacts'
import { mulberry32 } from './demoSignal'

/** Зона артефакта: интервал времени и каналы, которых он коснулся. */
export type ArtifactZone = {
  /** Идентификатор для ключей React и выделения (в API план — `kind-index`) */
  id: string
  kind: ArtifactKind
  onsetSec: number
  durationSec: number
  /** Каналы, по которым сработал детектор (для тултипа) */
  channels: string[]
}

/** Ручной вердикт эпохи: блокировка пользователя или снятие блокировки алгоритма. */
export type EpochManualVerdict = 'blocked' | 'allowed'

/** Эпоха нарезки: интервал + вердикт reject-фильтра + ручная правка пользователя. */
export type EpochCell = {
  index: number
  onsetSec: number
  durationSec: number
  /** Вердикт reject-фильтра: эпоха отброшена результатом расчёта */
  rejected: boolean
  /** Пометка пользователя (`null` — правок нет; см. `toggleEpochMark`) */
  manual: EpochManualVerdict | null
}

/**
 * Ручная пометка эпохи (срез 2.10): интервал на таймлайне сессии плюс вердикт.
 *
 * Пометка хранится **интервалом**, а не индексом: индекс живёт только внутри
 * своей нарезки, и после смены длины эпохи он указывал бы на другой участок
 * записи (та же причина, по которой штриховка результата считается по длине
 * эпохи самого результата, см. `gridEpochLength`).
 */
export type EpochMark = {
  onsetSec: number
  durationSec: number
  /** true — эпоха исключена из расчёта, false — блокировка алгоритма снята */
  blocked: boolean
}

/**
 * Слои результата, готовые к отрисовке.
 *
 * `rejectedEpochs` — индексы отброшенных эпох **в нарезке результата**, поэтому
 * вместе с ними приходит `epochLengthMs` (поле `epoch_length_ms` стадии
 * «эпохи»): раскладывать их по текущему параметру панели нельзя — штриховка
 * уехала бы на другой участок записи. Демо-фикстура от расчёта не зависит и
 * держит `epochLengthMs: null` — её индексы раскладываются по параметру.
 */
export type EdfViewerLayers = {
  artifacts: ArtifactZone[]
  rejectedEpochs: number[]
  epochLengthMs: number | null
  /** Откуда слои: фикстура разработки или результат задачи (срез 2.7) */
  source: 'demo' | 'result'
}

/** Защита от деления на ноль и от «эпохи нулевой длины» */
const MIN_EPOCH_SEC = 0.01

/** Погрешность сравнения интервалов, сек (float-арифметика окон/сетки) */
const MARK_EPS = 1e-3

/**
 * Длина эпохи сетки вьюера.
 *
 * У результата расчёта сетка своя (`epochLengthMs`) — индексы отброшенных эпох
 * привязаны именно к ней. У фикстуры и до первого расчёта сетка живая: она
 * строится по параметру панели.
 */
export function gridEpochLength(layers: EdfViewerLayers, paramEpochLengthMs: number): number {
  const fromResult = layers.source === 'result' ? layers.epochLengthMs : null
  return fromResult && fromResult > 0 ? fromResult : paramEpochLengthMs
}

/** Пересечение двух интервалов длиннее погрешности. */
function intervalsOverlap(
  a: { onsetSec: number; durationSec: number },
  b: { onsetSec: number; durationSec: number },
): boolean {
  const start = Math.max(a.onsetSec, b.onsetSec)
  const end = Math.min(a.onsetSec + a.durationSec, b.onsetSec + b.durationSec)
  return end - start > MARK_EPS
}

/**
 * Ручной вердикт эпохи: среди задевающих её пометок побеждает последняя
 * добавленная (пользователь правит поверх своей же правки).
 */
export function manualVerdict(
  marks: readonly EpochMark[],
  interval: { onsetSec: number; durationSec: number },
): EpochManualVerdict | null {
  let verdict: EpochManualVerdict | null = null
  for (const mark of marks) {
    if (intervalsOverlap(mark, interval)) verdict = mark.blocked ? 'blocked' : 'allowed'
  }
  return verdict
}

/** Итоговый вердикт эпохи: ручная пометка перебивает решение reject-фильтра. */
export function isEpochBlocked(rejected: boolean, manual: EpochManualVerdict | null): boolean {
  return manual === null ? rejected : manual === 'blocked'
}

/**
 * Убирает из пометок участок `interval`, сохраняя их части слева и справа:
 * правка одной эпохи не должна стирать пометки соседних.
 */
function subtractInterval(
  marks: readonly EpochMark[],
  interval: { onsetSec: number; durationSec: number },
): EpochMark[] {
  const out: EpochMark[] = []
  for (const mark of marks) {
    const end = mark.onsetSec + mark.durationSec
    const cutStart = Math.max(mark.onsetSec, interval.onsetSec)
    const cutEnd = Math.min(end, interval.onsetSec + interval.durationSec)
    if (cutEnd - cutStart <= MARK_EPS) {
      out.push(mark)
      continue
    }
    if (cutStart - mark.onsetSec > MARK_EPS) {
      out.push({ ...mark, durationSec: cutStart - mark.onsetSec })
    }
    if (end - cutEnd > MARK_EPS) {
      out.push({ onsetSec: cutEnd, durationSec: end - cutEnd, blocked: mark.blocked })
    }
  }
  return out
}

/**
 * Ctrl+двойной клик: инверсия блокировки эпохи (`interval` — эпоха под курсором).
 *
 * Пометку храним только тогда, когда вердикт расходится с решением алгоритма:
 * у эпохи, которую reject-фильтр и так отбросил, «выключение» блокировки — это
 * пометка `allowed`, а «включение» — просто снятие ручной правки (вердикт
 * возвращается к алгоритмическому).
 */
export function toggleEpochMark(
  marks: readonly EpochMark[],
  interval: { onsetSec: number; durationSec: number },
  rejectedByAlgorithm: boolean,
): EpochMark[] {
  const blocked = !isEpochBlocked(rejectedByAlgorithm, manualVerdict(marks, interval))
  const rest = subtractInterval(marks, interval)
  if (blocked === rejectedByAlgorithm) return rest
  return [...rest, { ...interval, blocked }]
}

/** Эпоха, в интервал которой попадает момент времени (курсор вьюера). */
export function cellAtTime(cells: readonly EpochCell[], timeSec: number): EpochCell | null {
  const hit = cells.find(
    (cell) => timeSec >= cell.onsetSec && timeSec < cell.onsetSec + cell.durationSec,
  )
  if (hit) return hit
  // Хвост последней эпохи может быть короче: правый край относим к ней
  const last = cells.at(-1)
  if (last && timeSec >= last.onsetSec && timeSec <= last.onsetSec + last.durationSec) return last
  return null
}

/** Подпись эпохи: решение алгоритма, ручная блокировка или снятая блокировка. */
export function epochMarkTitle(cell: EpochCell): string {
  const range = formatSecondsRange(cell.onsetSec, cell.durationSec)
  if (cell.manual === 'blocked') return `Эпоха ${cell.index + 1}: заблокирована вручную · ${range}`
  if (cell.manual === 'allowed') {
    return `Эпоха ${cell.index + 1}: блокировка reject-фильтра снята вручную · ${range}`
  }
  return `Эпоха ${cell.index + 1}: отброшена reject-фильтром · ${range}`
}

/**
 * Потолок числа эпох в сетке: больше маркеров всё равно неразличимо (и дорого
 * анимировать). Срабатывает только на вырожденных параметрах.
 */
export const MAX_EPOCH_CELLS = 2000

/**
 * Сетка эпох по длине сессии и длине эпохи нарезки.
 *
 * Эпохи покрывают запись подряд; последняя может быть короче (хвост сессии) —
 * так же, как нарезает `epoch_segmenter.py` на бэкенде.
 *
 * `rejected` — индексы отброшенных эпох **этой** нарезки, `marks` — ручные
 * пометки пользователя (интервалы на таймлайне): они раскладываются по сетке
 * пересечением, поэтому переживают смену длины эпохи.
 */
export function buildEpochCells(
  durationSec: number,
  epochLengthMs: number,
  rejected: readonly number[] = [],
  marks: readonly EpochMark[] = [],
): EpochCell[] {
  const lengthSec = Math.max(MIN_EPOCH_SEC, epochLengthMs / 1000)
  const totalSec = Math.max(0, durationSec)
  // -1e-9: 30 с / 2 с не должно давать 16-ю эпоху из-за погрешности float
  const total = Math.max(0, Math.ceil(totalSec / lengthSec - 1e-9))
  const rejectedSet = new Set(rejected)
  const count = Math.min(total, MAX_EPOCH_CELLS)

  const cells: EpochCell[] = []
  for (let index = 0; index < count; index++) {
    const onsetSec = index * lengthSec
    const durationSecCell = Math.min(lengthSec, totalSec - onsetSec)
    const interval = { onsetSec, durationSec: durationSecCell }
    cells.push({
      index,
      ...interval,
      rejected: rejectedSet.has(index),
      manual: marks.length ? manualVerdict(marks, interval) : null,
    })
  }
  return cells
}

/** Зоны, включённые в легенде: `artifactVisibility` из параметров отрисовки. */
export function visibleZones(
  zones: readonly ArtifactZone[],
  visibility: Record<ArtifactKind, boolean>,
): ArtifactZone[] {
  return zones.filter((zone) => visibility[zone.kind] !== false)
}

/**
 * Зоны, попавшие в канал трека (развёрнутый вид): детектор сработал на этом
 * канале либо на всём монтаже (пустой список каналов = весь монтаж — так же
 * читает `artifactZoneText`). Остальные зоны на трек канала не попадают: полоса
 * чужого канала на развёрнутом холсте — шум, а не информация.
 */
export function zonesForChannel(
  zones: readonly ArtifactZone[],
  channel: string,
): ArtifactZone[] {
  return zones.filter(
    (zone) => zone.channels.length === 0 || zone.channels.includes(channel),
  )
}

/** Интервал зоны для тултипа: «0.300–1.100 с» */
export function formatSecondsRange(onsetSec: number, durationSec: number): string {
  return `${onsetSec.toFixed(3)}–${(onsetSec + durationSec).toFixed(3)} с`
}

/**
 * Полная подпись зоны для тултипа и `aria-label`: тип, интервал и каналы.
 * Один текст и для нативного тултипа (`title`), и для панели выделенной зоны —
 * чтобы формулировка не расходилась между местами.
 */
export function artifactZoneText(zone: ArtifactZone): string {
  const channels = zone.channels.length ? zone.channels.join(', ') : 'весь монтаж'
  return `${ARTIFACT_LABELS[zone.kind]}: ${formatSecondsRange(zone.onsetSec, zone.durationSec)} · каналы: ${channels}`
}

/** Сводка зон по типам (для легенды вьюера): сколько зон каждого типа видно. */
export function artifactCounts(zones: readonly ArtifactZone[]): Record<ArtifactKind, number> {
  const counts = {
    zscore_outlier: 0,
    peak_to_peak: 0,
    flat_line: 0,
    clipping: 0,
    break: 0,
    electrode_pop: 0,
    muscle_emg: 0,
    line_noise: 0,
    ocular: 0,
    ecg: 0,
    ica_eog: 0,
  } satisfies Record<ArtifactKind, number>
  for (const zone of zones) counts[zone.kind] += 1
  return counts
}

/** Сид фикстуры слоёв: одна и та же запись всегда показывает одни и те же зоны */
export const DEMO_LAYERS_SEED = 42

/**
 * Разброс длительности зоны по типу артефакта, секунды.
 * Значения отражают природу артефакта: всплеск peak-to-peak короткий, а
 * EOG-компонент ICA тянется секундами.
 */
const ZONE_DURATION_SEC: Record<ArtifactKind, [number, number]> = {
  zscore_outlier: [0.4, 1.6],
  peak_to_peak: [0.15, 0.7],
  flat_line: [0.2, 1.1],
  clipping: [0.2, 1.2],
  break: [0.5, 2.5],
  electrode_pop: [0.1, 0.4],
  muscle_emg: [0.3, 1.4],
  line_noise: [1.5, 4.5],
  ocular: [0.2, 0.6],
  ecg: [0.3, 0.6],
  ica_eog: [0.8, 2.6],
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Каналы «под ударом»: случайное подмножество пула, но всегда непустое. */
function pickChannels(pool: string[], rand: () => number, maxCount: number): string[] {
  if (pool.length === 0) return []
  const limit = Math.max(1, Math.min(maxCount, pool.length))
  const picked: string[] = []
  for (const name of pool) {
    if (picked.length >= limit) break
    if (rand() < 0.35) picked.push(name)
  }
  if (picked.length === 0) picked.push(pool[Math.floor(rand() * pool.length)] as string)
  return picked
}

/**
 * Фикстура слоёв результата: 2–4 зоны каждого типа, разложенные по сессии,
 * и ~18 % отброшенных эпох. Детерминирована сидом, поэтому одинакова между
 * перерисовками и запусками — иначе тесты и сравнение «до/после» были бы шумом.
 *
 * EOG-компонент ICA бьёт по всем каналам сразу, остальные детекторы — по
 * подмножеству: тултип зоны должен уметь показать и один канал, и весь монтаж.
 */
export function demoLayers(
  durationSec: number,
  channels: string[] = [],
  seed: number = DEMO_LAYERS_SEED,
): EdfViewerLayers {
  const totalSec = Math.max(0, durationSec)
  const rand = mulberry32(seed)
  const pool = channels.filter(Boolean)
  const artifacts: ArtifactZone[] = []

  ARTIFACT_KINDS.forEach((kind) => {
    const count = 2 + Math.floor(rand() * 3)
    const [minDuration, maxDuration] = ZONE_DURATION_SEC[kind]
    for (let i = 0; i < count; i++) {
      const durationSec = Math.min(totalSec, minDuration + rand() * (maxDuration - minDuration))
      const slot = (totalSec * (i + 0.5)) / count
      const jitter = (rand() - 0.5) * (totalSec / count) * 0.6
      const onsetSec = Math.min(Math.max(0, totalSec - durationSec), Math.max(0, slot + jitter))
      artifacts.push({
        id: `${kind}-${i + 1}`,
        kind,
        onsetSec: round3(onsetSec),
        durationSec: round3(durationSec),
        // ICA-EOG и сетевой шум бьют по всем каналам сразу, остальные детекторы —
        // по подмножеству: тултип зоны должен уметь показать и один, и весь монтаж.
        channels:
          kind === 'ica_eog' || kind === 'line_noise' ? [...pool] : pickChannels(pool, rand, 3),
      })
    }
  })

  // Отброшенные эпохи: оценка сетки 2 с — индексы раскладываются по сетке вьюера
  // уже на клиенте, а `epochLengthMs: null` помечает фикстуру как «не расчёт».
  const approxCells = Math.max(1, Math.ceil(totalSec / 2))
  const rejectedEpochs: number[] = []
  for (let index = 0; index < approxCells; index++) {
    if (rand() < 0.18) rejectedEpochs.push(index)
  }
  if (rejectedEpochs.length === 0) rejectedEpochs.push(Math.min(2, approxCells - 1))

  return { artifacts, rejectedEpochs, epochLengthMs: null, source: 'demo' }
}
