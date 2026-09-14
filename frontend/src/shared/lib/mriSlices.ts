/**
 * Картинки срезов МРТ в проекциях мозга (срез 3.2).
 *
 * Срез приходит с бэкенда **готовым PNG** (`GET /surface/mri/slice/{plane}/{mm}.png`),
 * поэтому модуль занимается арифметикой вокруг ссылки, а не пикселями:
 *
 * * срез квантуется к сетке тома — картинка существует только на узлах 1 мм,
 *   поэтому URL обязан быть целым узлом (иначе браузер кэширует десять копий
 *   одного и того же среза);
 * * в URL уходит версия ассета: браузер держит картинки по URL, и после смены
 *   данных fsaverage старые не должны «залипнуть» в кэше;
 * * прямоугольник картинки равен прямоугольнику плоскости: границы тома
 *   (`MNI_BRAIN_BOUNDS`) и есть границы проекции, а масштаб мм/пиксель общий
 *   (`PROJECTION_SCALE`), поэтому `<image>` ложится без растяжения — пиксель
 *   картинки и миллиметр среза имеют одну цену по обеим осям.
 *
 * Модуль чистый (без DOM и zustand): арифметика покрыта `mriSlices.test.ts`,
 * отрисовка — в `sections/dipoles/MriProjection.tsx`.
 */
import type { MriSliceRef } from '@/shared/api/types'
import {
  PROJECTION_PADDING,
  clampSlice,
  projectionBox,
  roundMm,
  type ProjectionPlane,
} from './mriProjections'

/**
 * Срез к сетке тома: округление «половина вверх» — так же, как в бэкенде
 * (`app/services/mri_slices.py::slice_index`), иначе картинка и подпись среза
 * разъедутся на полшага.
 */
export function snapSliceToGrid(valueMm: number, spacingMm: number): number {
  const spacing = spacingMm > 0 ? spacingMm : 1
  return Math.floor(valueMm / spacing + 0.5) * spacing
}

/** Срез, который реально показывает картинка: сетка тома + границы плоскости. */
export function sliceImageMm(
  plane: ProjectionPlane,
  valueMm: number,
  spacingMm: number,
): number {
  return roundMm(clampSlice(plane, snapSliceToGrid(valueMm, spacingMm)))
}

/**
 * URL картинки среза. Версия ассета — в строке запроса: без неё браузер отдавал бы
 * старую картинку после пересборки тома.
 */
export function mriSliceUrl(
  ref: MriSliceRef,
  plane: ProjectionPlane,
  valueMm: number,
): string {
  const mm = sliceImageMm(plane, valueMm, ref.spacing_mm)
  return `${ref.slice_url}/${plane}/${mm}.png?v=${ref.version}`
}

/** Прямоугольник картинки в пикселях фигуры: срез накрывает всю плоскость. */
export function mriSliceRect(
  plane: ProjectionPlane,
  padding = PROJECTION_PADDING,
): { x: number; y: number; width: number; height: number } {
  const box = projectionBox(plane, padding)
  return { x: padding, y: padding, width: box.innerWidth, height: box.innerHeight }
}

/** Пояснение к картинке для подписи под фигурой, если она не загрузилась. */
export const MRI_SLICE_UNAVAILABLE =
  'срез МРТ недоступен: проверьте том fsaverage на сервере'