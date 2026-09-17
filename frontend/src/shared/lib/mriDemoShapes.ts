/**
 * Демонстрационные фигуры проекций мозга: силуэт головы, схема среза и поля
 * Бродмана (фикстуры среза 3.1).
 *
 * Зачем отдельный модуль
 * ----------------------
 * `mriProjections.ts` — **геометрия** проекций: переводы MNI ↔ фигура, сетка,
 * следы срезов, подписи краёв. Эти функции не изменятся, когда появятся реальные
 * данные. Здесь лежат **подстановочные фигуры**, которые нужны только до того
 * момента: панель обязана быть рабочей (наведение срезов, линейка, подсветка
 * полей) без бэкенда, поэтому анатомия до поры — детерминированная схема.
 *
 * Что это значит на практике:
 *
 * * фигуры **условны** и в интерфейсе честно помечены схемой (`MriProjection.tsx`
 *   рисует их только при отсутствии реального тома — иначе поверх настоящей
 *   томографии появилась бы «вторая» анатомия);
 * * замена на реальные данные — смена источника, а не отрисовки: поля придут из
 *   `PALS_B12_Brodmann` (`backend/app/services/surface_cache.py` → контуры),
 *   структуры — из `aparc+aseg` (`services/atlas_contours.py`), срез — из
 *   `T1.mgz` (`services/mri_slices.py`);
 * * когда реальные слои закроют все три фикстуры, **этот файл удаляется целиком**
 *   (вместе с `SLICE_STRUCTURE_MIN_ALPHA`/`AREA_MIN_ALPHA`), и правок в геометрии
 *   для этого не требуется — ради этого и разделено.
 *
 * Все формулы чистые (без DOM и zustand) и покрыты `mriDemoShapes.test.ts`:
 * контур головы детерминирован и сужается к полюсам диапазона срезов, структуры
 * и поля проявляются по глубине, попадание в поле считается по тем же эллипсам,
 * что нарисованы.
 */
import { sliceFraction, type MniPoint2, type ProjectionPlane } from './mriProjections'

/** Число точек контура головы: достаточно для гладкой формы без тяжёлого DOM. */
export const CONTOUR_SAMPLES = 96

/** Условные оси эллипса-силуэта в нормализованных координатах каждой плоскости.
 *
 * Полурадиусы заданы долями размаха своей оси: анатомию это не искажает — в
 * пиксели их переводит единый масштаб мм/пиксель (`normalizedToPx`), поэтому
 * вытянутая по y голова в аксиальной проекции получается вытянутой и на экране.
 */
const DEMO_HEAD_SHAPE: Record<
  ProjectionPlane,
  { semiU: number; semiV: number; centerU: number; centerV: number }
> = {
  axial: { semiU: 0.9, semiV: 0.84, centerU: 0, centerV: -0.08 },
  sagittal: { semiU: 0.82, semiV: 0.88, centerU: 0, centerV: 0.04 },
  coronal: { semiU: 0.86, semiV: 0.86, centerU: 0, centerV: -0.02 },
}

/** Остаточный размер контура у полюсов среза: фигура не схлопывается в точку. */
const CONTOUR_MIN_SHRINK = 0.35

/** Точки контура границ головы на срезе (нормализованные координаты фигуры). */
export function demoHeadContours(plane: ProjectionPlane, sliceMm: number): MniPoint2[] {
  const shape = DEMO_HEAD_SHAPE[plane]
  // Глубина среза: −1…+1 от середины диапазона к границам
  const t = sliceFraction(plane, sliceMm) * 2 - 1
  const shrink = CONTOUR_MIN_SHRINK + (1 - CONTOUR_MIN_SHRINK) * Math.sqrt(Math.max(0, 1 - t * t))

  const points: MniPoint2[] = []
  for (let index = 0; index < CONTOUR_SAMPLES; index++) {
    const angle = (index / CONTOUR_SAMPLES) * Math.PI * 2
    points.push({
      u: shape.centerU + Math.cos(angle) * shape.semiU * shrink,
      v: shape.centerV + Math.sin(angle) * shape.semiV * shrink,
    })
  }
  return points
}

/** Поле Бродмана на срезе: эллипс в нормализованных координатах + видимость. */
export type MniAreaShape = {
  name: string
  center: MniPoint2
  /** Полурадиусы эллипса в нормализованных единицах (u — горизонталь, v — вертикаль) */
  radius: MniPoint2
  /** Проявление поля на этом срезе, 0…1: поля уходят по глубине, а не «висят» все сразу */
  alpha: number
}

/**
 * Раскладка фикстуры полей Бродмана: несколько областей на плоскость.
 * `t0` — глубина среза (в тех же −1…+1), где поле проявляется максимально,
 * `spread` — насколько быстро оно уходит. Реальные поля придут из
 * `PALS_B12_Brodmann` (`backend/app/services/surface_cache.py`), эта таблица — фикстура.
 */
const DEMO_BA_LAYOUT: Record<
  ProjectionPlane,
  { name: string; u: number; v: number; ru: number; rv: number; t0: number; spread: number }[]
> = {
  axial: [
    { name: 'BA4', u: 0.34, v: 0.22, ru: 0.22, rv: 0.3, t0: 0.3, spread: 1.5 },
    { name: 'BA6', u: 0.3, v: 0.52, ru: 0.2, rv: 0.26, t0: 0.1, spread: 1.6 },
    { name: 'BA17', u: 0, v: -0.72, ru: 0.34, rv: 0.26, t0: -0.2, spread: 1.5 },
    { name: 'BA41', u: -0.52, v: -0.18, ru: 0.24, rv: 0.3, t0: -0.4, spread: 1.2 },
  ],
  sagittal: [
    { name: 'BA8', u: 0.36, v: 0.44, ru: 0.24, rv: 0.26, t0: 0.4, spread: 1.5 },
    { name: 'BA31', u: 0.05, v: 0.5, ru: 0.26, rv: 0.2, t0: -0.1, spread: 1.6 },
    { name: 'BA17', u: -0.62, v: -0.3, ru: 0.24, rv: 0.34, t0: -0.3, spread: 1.5 },
    { name: 'BA22', u: 0.2, v: -0.62, ru: 0.32, rv: 0.22, t0: 0, spread: 1.4 },
  ],
  coronal: [
    { name: 'BA4', u: 0.36, v: 0.42, ru: 0.24, rv: 0.3, t0: 0.5, spread: 1.5 },
    { name: 'BA6', u: 0.3, v: 0.62, ru: 0.22, rv: 0.22, t0: 0.2, spread: 1.6 },
    { name: 'BA44', u: 0.56, v: -0.12, ru: 0.2, rv: 0.24, t0: -0.5, spread: 1.3 },
    { name: 'BA17', u: -0.7, v: -0.18, ru: 0.2, rv: 0.28, t0: -0.4, spread: 1.4 },
  ],
}

/** Ниже этой видимости поле на срезе не рисуем: иначе «пыль» из полупрозрачных пятен. */
const AREA_MIN_ALPHA = 0.15

/** Поля Бродмана, видимые на текущем срезе (фикстура, пока нет реальных полей). */
export function demoBrodmannAreas(plane: ProjectionPlane, sliceMm: number): MniAreaShape[] {
  const t = sliceFraction(plane, sliceMm) * 2 - 1
  return DEMO_BA_LAYOUT[plane]
    .map((area) => ({
      name: area.name,
      center: { u: area.u, v: area.v },
      radius: { u: area.ru, v: area.rv },
      alpha: Math.min(1, Math.max(0, 1 - Math.abs(t - area.t0) / area.spread)),
    }))
    .filter((area) => area.alpha >= AREA_MIN_ALPHA)
}

/**
 * Поле Бродмана под точкой фигуры (`null` — попадание вне полей).
 *
 * Клик по полю подсвечивает его (`docs/ui.md` §3.3: «подсветка поля Бродмана/ROI»),
 * поэтому попадание проверяется по тем же эллипсам, что нарисованы на canvas:
 * геометрия одна, без второго «невидимого» слоя для мыши.
 */
export function brodmannAreaAt(
  plane: ProjectionPlane,
  sliceMm: number,
  point: MniPoint2,
): string | null {
  const areas = demoBrodmannAreas(plane, sliceMm)
  for (let index = areas.length - 1; index >= 0; index--) {
    const area = areas[index]
    const du = (point.u - area.center.u) / area.radius.u
    const dv = (point.v - area.center.v) / area.radius.v
    if (du * du + dv * dv <= 1) return area.name
  }
  return null
}

/**
 * Анатомический ориентир на срезе MNI (фикстура слоя «Срезы MNI»).
 *
 * Пока реального тома нет, срез рисуется схемой: желудочки, мозолистое тело,
 * ствол, таламус. Схема не претендует на точность — она нужна, чтобы смена
 * срезов была **видна** (структуры уходят по глубине, форма контура меняется),
 * а не чтобы заменять томографию. Реальные срезы — отдельный серверный актив
 * (`docs/ui.md` §3.3, §12), тогда эта таблица станет не нужна.
 */
export type MniSliceStructure = {
  id: string
  label: string
  center: MniPoint2
  /** Полурадиусы эллипса в нормализованных единицах (u — горизонталь, v — вертикаль) */
  radius: MniPoint2
  /** Проявление на этом срезе, 0…1 */
  alpha: number
  /** Полость (желудочек) рисуется обводкой, а не заливкой */
  hollow: boolean
}

/** Раскладка схемы среза: `t0` — глубина (в −1…+1), где структура видна лучше всего. */
const DEMO_SLICE_LAYOUT: Record<
  ProjectionPlane,
  {
    id: string
    label: string
    u: number
    v: number
    ru: number
    rv: number
    t0: number
    spread: number
    hollow?: boolean
  }[]
> = {
  axial: [
    {
      id: 'ventricles',
      label: 'желудочки',
      u: 0,
      v: 0.12,
      ru: 0.28,
      rv: 0.14,
      t0: 0.45,
      spread: 1.1,
      hollow: true,
    },
    { id: 'thalamus', label: 'таламус', u: 0, v: -0.18, ru: 0.24, rv: 0.16, t0: 0.1, spread: 1.3 },
    {
      id: 'brainstem',
      label: 'ствол мозга',
      u: 0,
      v: -0.52,
      ru: 0.15,
      rv: 0.16,
      t0: -0.4,
      spread: 1.2,
    },
  ],
  sagittal: [
    {
      id: 'ventricles',
      label: 'желудочки',
      u: 0.02,
      v: 0.1,
      ru: 0.24,
      rv: 0.12,
      t0: 0.3,
      spread: 1.2,
      hollow: true,
    },
    {
      id: 'callosum',
      label: 'мозолистое тело',
      u: 0.04,
      v: 0.32,
      ru: 0.3,
      rv: 0.1,
      t0: 0.2,
      spread: 1.4,
    },
    {
      id: 'brainstem',
      label: 'ствол мозга',
      u: 0,
      v: -0.28,
      ru: 0.13,
      rv: 0.28,
      t0: -0.2,
      spread: 1.3,
    },
    {
      id: 'cerebellum',
      label: 'мозжечок',
      u: -0.58,
      v: -0.46,
      ru: 0.22,
      rv: 0.2,
      t0: -0.5,
      spread: 1.5,
    },
  ],
  coronal: [
    {
      id: 'ventricles',
      label: 'желудочки',
      u: 0,
      v: 0.14,
      ru: 0.22,
      rv: 0.2,
      t0: 0.35,
      spread: 1.2,
      hollow: true,
    },
    {
      id: 'callosum',
      label: 'мозолистое тело',
      u: 0,
      v: 0.36,
      ru: 0.3,
      rv: 0.08,
      t0: 0.25,
      spread: 1.4,
    },
    {
      id: 'thalamus_l',
      label: 'таламус слева',
      u: 0.22,
      v: -0.1,
      ru: 0.16,
      rv: 0.14,
      t0: 0.05,
      spread: 1.3,
    },
    {
      id: 'thalamus_r',
      label: 'таламус справа',
      u: -0.22,
      v: -0.1,
      ru: 0.16,
      rv: 0.14,
      t0: 0.05,
      spread: 1.3,
    },
  ],
}

/** Ниже этого проявления структура на срезе не рисуется: не «пыль» полупрозрачных пятен. */
export const SLICE_STRUCTURE_MIN_ALPHA = 0.12

/** Структуры схемы среза, видимые на текущем срезе (фикстура слоя «Срезы MNI»). */
export function demoSliceStructures(plane: ProjectionPlane, sliceMm: number): MniSliceStructure[] {
  const t = sliceFraction(plane, sliceMm) * 2 - 1
  return DEMO_SLICE_LAYOUT[plane]
    .map((structure) => ({
      id: structure.id,
      label: structure.label,
      center: { u: structure.u, v: structure.v },
      radius: { u: structure.ru, v: structure.rv },
      alpha: Math.min(1, Math.max(0, 1 - Math.abs(t - structure.t0) / structure.spread)),
      hollow: structure.hollow === true,
    }))
    .filter((structure) => structure.alpha >= SLICE_STRUCTURE_MIN_ALPHA)
}
