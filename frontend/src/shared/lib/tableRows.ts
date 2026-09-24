/**
 * Таблица локализации (срез 4): строки из результата расчёта диполей.
 *
 * Модуль **чистый**: сервер отдаёт точки (`DipoleScanResult.points`), а UI только
 * раскладывает их по колонкам, сортирует и форматирует. Ни одного запроса и ни
 * одной выдуманной величины:
 *
 * * точки без MNI (fsaverage недоступен) **остаются в таблице** — «все результаты
 *   расчёта» это все, а не «те, что удалось навести»; координаты у них показаны
 *   как «—», а причина приходит предупреждением задачи (тот же принцип, что в
 *   слое проекций: там такие точки не рисуются, здесь — честно показаны);
 * * «полушарие» не приходит отдельным полем API: оно выводится из знака MNI x
 *   (x > 0 — правое, RAS-раскладка проекций, см. `mriProjections.ts`), и это
 *   сказано в подсказке колонки — производная величина не должна выглядеть как
 *   измеренная;
 * * «структура» и «поле Бродмана» — **разные колонки**: структура читается
 *   сервером из объёма `aparc+aseg` по координате точки (та же метка, что и
 *   контуры срезов), а поле — производная разметка коры (`PALS_B12_Brodmann`).
 *   Одинаковые подписи у них читались бы как одна величина, измеренная дважды;
 *   служебное `unknown` сервера и пустые строки снимаются той же нормализацией,
 *   что и в тултипах проекций (`atlasLabel` в `dipolePoints.ts`): «не определено»
 *   показывается «—» и не выглядит измеренной величиной;
 * * ROI в результате пока нет (точка помечена полем Бродмана и структурой),
 *   поэтому колонки ROI в таблице не будет, пока нет данных: пустая колонка «ROI»
 *   читалась бы как «ROI не определён», хотя его просто не считали.
 *
 * Сортировка — **по номеру эпохи** (требование среза): основной ключ — номер,
 * вторичный — время пика GFP в ту же сторону, чтобы переключение направления
 * просто переворачивало таблицу, а строки одной эпохи не «смешивались».
 */
import type { DipoleScanResult } from '@/shared/api/types'
import { atlasLabel, attributionText, labelWithDistance, outsideBrainText } from './dipolePoints'

/** Прочерк вместо отсутствующего значения: «не измерено» ≠ «ноль». */
export const EM_DASH = '—'

/** Направление сортировки строк. */
export type TableSortDirection = 'asc' | 'desc'

/** Ключи колонок таблицы локализации. */
export type TableColumnKey =
  | 'epoch'
  | 'time'
  | 'x'
  | 'y'
  | 'z'
  | 'hemisphere'
  | 'structure'
  | 'amplitude'
  | 'gof'
  | 'area'

export type TableColumn = {
  key: TableColumnKey
  /** Заголовок колонки (единицы — в заголовке, а не в каждой ячейке) */
  label: string
  /** Подсказка заголовка: что за величина и откуда взялась */
  hint: string
  /** Числовая колонка: выравнивание вправо и табличные цифры */
  numeric: boolean
  /** Ширина колонки (класс Tailwind) */
  width: string
}

/**
 * Колонки таблицы — в том порядке, в каком они рисуются.
 *
 * Время — **пик GFP внутри эпохи** (`time_ms`), а не время от начала записи:
 * быстрый режим берёт один отсчёт на эпоху, и подписывать его абсолютным
 * временем значило бы выдавать кадр за точку траектории.
 */
export const TABLE_COLUMNS: TableColumn[] = [
  {
    key: 'epoch',
    label: 'Эпоха',
    hint: 'Номер эпохи нарезки результата (с 1) — по нему идёт сортировка',
    numeric: true,
    width: 'w-20',
  },
  {
    key: 'time',
    label: 'Пик GFP, с',
    hint: 'Время пика GFP внутри эпохи (не от начала записи)',
    numeric: true,
    width: 'w-28',
  },
  { key: 'x', label: 'MNI x, мм', hint: 'MNI x (мм), x > 0 — правое полушарие', numeric: true, width: 'w-24' },
  { key: 'y', label: 'MNI y, мм', hint: 'MNI y (мм): вперёд/назад от AC–PC', numeric: true, width: 'w-24' },
  { key: 'z', label: 'MNI z, мм', hint: 'MNI z (мм): вверх/вниз от AC–PC', numeric: true, width: 'w-24' },
  {
    key: 'amplitude',
    label: 'Амплитуда, нАм',
    hint: 'Момент диполя, нА·м: порог «КД ≥» из раздела «Диполи» на таблицу не влияет',
    numeric: true,
    width: 'w-28',
  },
  { key: 'gof', label: 'GOF, %', hint: 'Goodness of fit: доля объяснённой дисперсии поля', numeric: true, width: 'w-24' },
  {
    key: 'hemisphere',
    label: 'Полушарие',
    hint: 'Выведено из знака MNI x (x > 0 — правое): отдельного поля в результате нет',
    numeric: false,
    width: 'w-32',
  },
  {
    key: 'structure',
    label: 'Структура',
    hint: 'Структура атласа aparc+aseg по MNI-координате точки (тот же атлас, что и контуры срезов); «—» — координат нет или метки в узле нет',
    numeric: false,
    width: 'w-48',
  },
  {
    key: 'area',
    label: 'Поле Бродмана',
    hint: 'Поле по MNI-точке (атлас PALS_B12_Brodmann); «—» — не определено',
    numeric: false,
    width: 'w-36',
  },
]

/** Видимость колонок: ключ → показывать ли колонку. */
export type TableColumnVisibility = Record<TableColumnKey, boolean>

/** По умолчанию показаны все колонки: скрывать — осознанный выбор пользователя. */
export function defaultColumnVisibility(): TableColumnVisibility {
  return Object.fromEntries(TABLE_COLUMNS.map((column) => [column.key, true])) as TableColumnVisibility
}

/** Колонки, которые нужно нарисовать (в порядке `TABLE_COLUMNS`). */
export function visibleColumns(visibility: TableColumnVisibility): TableColumn[] {
  return TABLE_COLUMNS.filter((column) => visibility[column.key] !== false)
}

/** Сколько колонок скрыто (для подписи панели). */
export function hiddenColumnCount(visibility: TableColumnVisibility): number {
  return TABLE_COLUMNS.length - visibleColumns(visibility).length
}

/** Одна строка таблицы: точка результата, разложенная по колонкам. */
export type LocalizationRow = {
  /** Ключ React — «эпоха-время пика» (тот же, что у точек проекций) */
  id: string
  epochIndex: number
  timeMs: number
  /** MNI-координаты, мм; `null` — координат нет (fsaverage недоступен) */
  mni: [number, number, number] | null
  amplitudeNaM: number
  gof: number
  /** Поле Бродмана (`null` — не определено) */
  area: string | null
  /**
   * Анатомическая структура по MNI-координате (атлас `aparc+aseg`).
   *
   * Приходит **готовой от сервера** (`anatomical_structure`): координаты считает
   * сервер, и «угадывать» структуру на клиенте по контурам срезов значило бы
   * получить вторую, не совпадающую с расчётом анатомию. `null` — координат нет
   * или метки в узле нет: в ячейке «—».
   */
  structure: string | null
  /** Расстояние до ближайшей структуры, мм (шаг 1.4); `null` — координат/атласа нет */
  structureDistanceMm: number | null
  /** Расстояние до ближайшего узла поля Бродмана, мм (шаг 1.4) */
  areaDistanceMm: number | null
  /** Признак «вне мозга» (`brainmask`, шаг 1.4): `null` — маска недоступна */
  outsideBrain: boolean | null
}

/**
 * Строки таблицы из результата задачи: **все** точки, в порядке ответа сервера.
 * Сортировка — отдельная функция (порядок из API не обязан совпадать с показом).
 */
export function localizationRows(result: DipoleScanResult): LocalizationRow[] {
  return result.points.map((point) => ({
    id: `${point.epoch_index}-${Math.round(point.time_ms)}`,
    epochIndex: point.epoch_index,
    timeMs: point.time_ms,
    mni: mniOf(point.mni_coords),
    amplitudeNaM: point.amplitude_nam,
    gof: point.gof,
    // Метки нормализуются здесь (одно место): `unknown` сервера и пустые строки
    // становятся `null` — в ячейке «—», в подсказке строки их просто нет.
    area: atlasLabel(point.brodmann_area),
    structure: atlasLabel(point.anatomical_structure),
    structureDistanceMm: point.structure_distance_mm,
    areaDistanceMm: point.brodmann_distance_mm,
    outsideBrain: point.outside_brain,
  }))
}

/** Точки без MNI: их не наводят на проекции (срез 3.4), но в таблице они есть. */
export function missingMniCount(rows: LocalizationRow[]): number {
  return rows.filter((row) => row.mni === null).length
}

/** Сортировка по номеру эпохи; `asc` — от ранних к поздним. */
export function sortRowsByEpoch(
  rows: LocalizationRow[],
  direction: TableSortDirection = 'asc',
): LocalizationRow[] {
  const sign = direction === 'asc' ? 1 : -1
  return [...rows].sort(
    (a, b) => sign * (a.epochIndex - b.epochIndex) || sign * (a.timeMs - b.timeMs),
  )
}

/** Строки с сортировкой из настроек таблицы — то, что рисует компонент. */
export function tableRows(
  result: DipoleScanResult,
  direction: TableSortDirection = 'asc',
): LocalizationRow[] {
  return sortRowsByEpoch(localizationRows(result), direction)
}

/** Текст ячейки: числа — с единицами из заголовка, отсутствующее — «—». */
export function cellText(row: LocalizationRow, key: TableColumnKey): string {
  switch (key) {
    case 'epoch':
      return String(row.epochIndex + 1)
    case 'time':
      return (row.timeMs / 1000).toFixed(3)
    case 'x':
      return coordinateText(row.mni?.[0])
    case 'y':
      return coordinateText(row.mni?.[1])
    case 'z':
      return coordinateText(row.mni?.[2])
    case 'hemisphere':
      return hemisphereLabel(hemisphereOf(row.mni?.[0] ?? null))
    case 'structure':
      if (row.outsideBrain) return outsideBrainText(row.structure, row.structureDistanceMm)
      return row.structure ? labelWithDistance(row.structure, row.structureDistanceMm) : EM_DASH
    case 'amplitude':
      return Number.isFinite(row.amplitudeNaM) ? row.amplitudeNaM.toFixed(1) : EM_DASH
    case 'gof':
      return Number.isFinite(row.gof) ? (row.gof * 100).toFixed(1) : EM_DASH
    case 'area':
      // Вне мозга ближайшее поле — выдуманная атрибуция: прочерк вместо метки узла
      if (row.outsideBrain) return EM_DASH
      return row.area ? labelWithDistance(row.area, row.areaDistanceMm) : EM_DASH
  }
}

/** Сторона полушария по знаку MNI x (RAS: x > 0 — правое). */
export type Hemisphere = 'right' | 'left' | 'midline'

export function hemisphereOf(x: number | null): Hemisphere | null {
  if (x === null || !Number.isFinite(x)) return null
  if (x > 0) return 'right'
  if (x < 0) return 'left'
  return 'midline'
}

/** Подпись полушария: «—» — координат нет (точка без MNI). */
export function hemisphereLabel(hemisphere: Hemisphere | null): string {
  if (hemisphere === 'right') return 'правое (R)'
  if (hemisphere === 'left') return 'левое (L)'
  if (hemisphere === 'midline') return 'срединное (x = 0)'
  return EM_DASH
}

/** Подпись строки для тултипа: то же содержание, что у точки на проекциях (3.4). */
export function rowTooltip(row: LocalizationRow): string {
  const coords = row.mni
    ? `MNI ${row.mni.map((value) => value.toFixed(1)).join(' / ')}`
    : 'MNI нет (fsaverage недоступен) — на проекции точка не наводится'
  const anatomy = attributionText(
    {
      structure: row.structure,
      area: row.area,
      structureDistanceMm: row.structureDistanceMm,
      areaDistanceMm: row.areaDistanceMm,
      outsideBrain: row.outsideBrain,
    },
    '',
  )
  const suffix = anatomy ? `, ${anatomy}` : ''
  return `Эпоха ${row.epochIndex + 1}, пик ${(row.timeMs / 1000).toFixed(3)} с: ${coords}${suffix}, ${row.amplitudeNaM.toFixed(1)} нАм, GOF ${(row.gof * 100).toFixed(1)} %`
}

/** Подпись сортировки для статуса раздела: направление всегда названо словами. */
export function sortDirectionLabel(direction: TableSortDirection): string {
  return direction === 'asc' ? 'по номеру эпохи (возрастание)' : 'по номеру эпохи (убывание)'
}

/** Координата строкой: конечные миллиметры или «—». */
function coordinateText(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return EM_DASH
  return value.toFixed(1)
}

/** MNI из ответа сервера: только три конечных числа, иначе «координат нет». */
function mniOf(coords: number[] | null): [number, number, number] | null {
  if (!coords || coords.length !== 3) return null
  const [x, y, z] = coords
  if (![x, y, z].every(Number.isFinite)) return null
  return [x, y, z]
}

