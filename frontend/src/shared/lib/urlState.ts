/**
 * Общие параметры URL (3.2б, N33): ссылка воспроизводит состояние сессии.
 *
 * Раздел уже живёт в пути (`/edf`, `/eeg`, `/dipoles`…) — здесь то, что в путь
 * не помещается: открытая запись (`rec`) и срезы MNI (`slice`). Правило зеркала:
 * параметров нет — действуют дефолты сторов, есть — применяются один раз при
 * старте (`app/UrlSync.tsx`), а дальше сторы дописывают URL через `replace`
 * (история не засоряется).
 *
 * Форматы:
 *   ?rec=rec-1                    — id записи из реестра просмотра
 *   ?slice=axial:12,sagittal:-24  — срезы по плоскостям `PROJECTION_PLANES`, мм
 *
 * Значения, равные дефолтам, в URL не пишутся: отсутствие параметра = дефолт.
 * Мусор не валит приложение — нераспознанное просто игнорируется. Полоса
 * фильтра (`band`) убрана вместе с одиночным расчётом диполей: старые ссылки с
 * `?band=` открываются как обычно, параметр просто игнорируется.
 */
import {
  PROJECTION_PLANES,
  clampSlice,
  defaultSlices,
  roundMm,
  type ProjectionPlane,
} from '@/shared/lib/mriProjections'

/** Что синхронизируется с URL: каждому ключю владеет `UrlSync`, чужие не трогаем. */
export type SharedUrlState = {
  /** Открытая запись (id из реестра просмотра; null — записи нет) */
  rec: string | null
  /** Срезы MNI по плоскостям, мм (всегда определены — дефолт у каждой плоскости) */
  slices: Record<ProjectionPlane, number> | null
}

/** id записи: hex/слаг реестра — без спецсимволов (URL не используется как путь). */
const REC_RE = /^[\w.-]+$/

/** Разобрать query-параметры ссылки: мусор и чужие ключи игнорируются. */
export function parseSharedUrl(search: string): Partial<SharedUrlState> {
  const raw = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const parsed: Partial<SharedUrlState> = {}

  const rec = raw.get('rec')
  if (rec !== null && REC_RE.test(rec)) parsed.rec = rec

  const slice = raw.get('slice')
  if (slice !== null) {
    const slices: Partial<Record<ProjectionPlane, number>> = {}
    for (const part of slice.split(',')) {
      const [planeRaw, mmRaw] = part.split(':')
      if (!PROJECTION_PLANES.includes(planeRaw as ProjectionPlane)) continue
      const mm = Number(mmRaw)
      if (!Number.isFinite(mm)) continue
      const plane = planeRaw as ProjectionPlane
      slices[plane] = clampSlice(plane, roundMm(mm))
    }
    // Частичный slice дополняется дефолтами: неизвестная плоскость не валит остальные
    if (Object.keys(slices).length > 0) parsed.slices = { ...defaultSlices(), ...slices }
  }

  return parsed
}

/** Собрать query из состояния: дефолты не пишутся, отсутствие = дефолт. */
export function serializeSharedUrl(state: SharedUrlState): URLSearchParams {
  const query = new URLSearchParams()
  if (state.rec !== null) query.set('rec', state.rec)
  if (state.slices !== null && !isDefaultSlices(state.slices)) {
    query.set('slice', PROJECTION_PLANES.map((plane) => `${plane}:${state.slices![plane]}`).join(','))
  }
  return query
}

/** Срезы как `defaultSlices()`: такой URL тоже избыточен. */
function isDefaultSlices(slices: Record<ProjectionPlane, number>): boolean {
  const fallback = defaultSlices()
  return PROJECTION_PLANES.every((plane) => slices[plane] === fallback[plane])
}