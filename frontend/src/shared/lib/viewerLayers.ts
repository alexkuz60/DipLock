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

/** Эпоха нарезки: интервал + вердикт reject-фильтра. */
export type EpochCell = {
  index: number
  onsetSec: number
  durationSec: number
  rejected: boolean
}

/**
 * Слои результата, готовые к отрисовке.
 *
 * `rejectedEpochs` — индексы отброшенных эпох; клиент сам раскладывает их по
 * текущей сетке (`buildEpochCells`), поэтому смена длины эпохи не требует
 * пересчёта артефактов.
 */
export type EdfViewerLayers = {
  artifacts: ArtifactZone[]
  rejectedEpochs: number[]
  /** Откуда слои: фикстура разработки или результат задачи (срез 2.7) */
  source: 'demo' | 'result'
}

/** Защита от деления на ноль и от «эпохи нулевой длины» */
const MIN_EPOCH_SEC = 0.01

/**
 * Потолок числа эпох в сетке: больше маркеров всё равно неразличимо (и дорого
 * анимировать). Срабатывает только на вырожденных параметрах.
 */
export const MAX_EPOCH_CELLS = 2000

/**
 * Сетка эпох по длине сессии и длине эпохи из параметров.
 *
 * Эпохи покрывают запись подряд; последняя может быть короче (хвост сессии) —
 * так же, как нарезает `epoch_segmenter.py` на бэкенде.
 */
export function buildEpochCells(
  durationSec: number,
  epochLengthMs: number,
  rejected: readonly number[] = [],
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
    cells.push({
      index,
      onsetSec,
      durationSec: Math.min(lengthSec, totalSec - onsetSec),
      rejected: rejectedSet.has(index),
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
        channels: kind === 'ica_eog' ? [...pool] : pickChannels(pool, rand, 3),
      })
    }
  })

  // Отброшенные эпохи: оценка сетки 2 с — индексы раскладываются по текущей
  // длине эпохи уже на клиенте, поэтому фикстура не зависит от параметра.
  const approxCells = Math.max(1, Math.ceil(totalSec / 2))
  const rejectedEpochs: number[] = []
  for (let index = 0; index < approxCells; index++) {
    if (rand() < 0.18) rejectedEpochs.push(index)
  }
  if (rejectedEpochs.length === 0) rejectedEpochs.push(Math.min(2, approxCells - 1))

  return { artifacts, rejectedEpochs, source: 'demo' }
}
