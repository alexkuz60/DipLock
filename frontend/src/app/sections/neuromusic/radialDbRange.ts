/**
 * Конечная оптимизация радиальных значений звезды «Эмо» (постановка владельца
 * 23.10.2026): шкала радиуса применяется к радиусам векторов вершин и доминанты
 * **после** расчёта звезды (вращение → темп → `starPolygon` → `dominantPoint`),
 * а не к лучам кадров. Варианты шкалы (опция «Динамический диапазон»
 * панели «ЕмоЛаб», `RadialScaleKey`) и её **«Выкл»** (правка владельца
 * 30.10.2026, `null`):
 *
 * * `db-40` / `db-60` (решение владельца 23.10.2026 — лог-шкала): значение
 *   радиуса `v` (доля R, линейная шкала по пику трека) переводится в дБ
 *   `db = 20·log10(v)` (0 дБ = 100 % R) и переносится из окна `[floor…0]` дБ
 *   в `[0…1]` радиуса: `frac₂ = clip((db − floor) / (0 − floor), 0, 1)`;
 *   `frac ≤ 0` → 0.
 * * «Выкл» (`null`, 30.10.2026) — нормализация координат лучей звезды и
 *   доминант **линейно в диапазоне 0…1** (значение без переноса, как в
 *   «Нейромузыке» без пропа `radialScale`).
 *
 * Тихие значения раздвигаются (лог-зависимость громкости) — столбики
 * «Экспрессии Эмо» «Эмограммы» становятся естественнее. **Инвариант**:
 * перенос меняет только ДЛИНУ радиус-вектора, направление сохраняется —
 * поэтому углы доминант (а значит и график «Динамики Эмо»/ступени
 * эмоциональных секторов) не изменяются. Порядок применения — строго
 * конечный: лучи → вращение → темп → вершины → доминанта → перенос радиусов.
 *
 * Чистая математика без DOM — покрыта `radialDbRange.test.ts`; применяют
 * `neuromusic/RadialChart.tsx` (вершины, доминанта, облако) и
 * `emolab/emogram.ts` (`emoBars`).
 */
import type { RadialPoint } from './radialChart'

/**
 * Вариант шкалы радиальных значений (опция «Динамический диапазон»):
 * `db-40`/`db-60` — дБ-окно `[-40…0]`/`[-60…0]`. `null` — опция выключена
 * («Выкл»: линейно 0…1; то же — поведение «Нейромузыки» без пропа
 * `radialScale`).
 */
export type RadialScaleKey = 'db-40' | 'db-60'

/** Допустимые значения шкалы (порядок селектора «Динамический диапазон»). */
export const RADIAL_SCALE_KEYS: readonly RadialScaleKey[] = ['db-40', 'db-60']

/**
 * Перенос радиального значения в выбранную шкалу: доля радиуса `frac` (0…1,
 * 1 = 100 % R) → доля радиуса в шкале.
 *
 * - `frac ≤ 0`, не число → 0 (центр: тишина/равные лучи);
 * - `scale` `null`/неизвестный → значение **без изменений** (перенос выключен);
 * - доля ниже пола шкалы → 0 («глубже в тишину не показываем»), сверху — зажим 1.
 */
export function radialScaleFrac(
  frac: number,
  scale: RadialScaleKey | null | undefined,
): number {
  if (!Number.isFinite(frac) || frac <= 0) return 0
  const floorDb = scale === 'db-40' ? -40 : scale === 'db-60' ? -60 : null
  if (floorDb == null) return frac
  const db = 20 * Math.log10(frac)
  return Math.min(1, Math.max(0, (db - floorDb) / (0 - floorDb)))
}

/**
 * Тот же перенос для значений в процентах радиуса (0…100 % R — шкала лучей
 * `starPolygon`): `pct` → проценты в выбранной шкале.
 */
export function radialScalePct(
  pct: number,
  scale: RadialScaleKey | null | undefined,
): number {
  return radialScaleFrac(pct / 100, scale) * 100
}

/**
 * Перенос радиус-вектора точки `point` от центра `center`: длина `L`
 * (в единицах `radius`) переносится в выбранную шкалу, **направление
 * сохраняется** (инвариант: углы доминант и ступени «Эмограммы» не меняются).
 * Точка в центре либо неполадочный радиус — точка без изменений; перенос
 * выключен (`scale` вне `RADIAL_SCALE_KEYS`) — точка без изменений.
 */
export function radialScalePoint(
  point: RadialPoint,
  center: RadialPoint,
  radius: number,
  scale: RadialScaleKey | null | undefined,
): RadialPoint {
  const dx = point.x - center.x
  const dy = point.y - center.y
  const length = Math.hypot(dx, dy)
  if (!(length > 0) || !(radius > 0)) return { ...point }
  const scaled = (radialScaleFrac(length / radius, scale) * radius) / length
  return { x: center.x + dx * scaled, y: center.y + dy * scaled }
}

/** Перенос радиус-векторов массива точек (вершины полигона, облако доминант). */
export function radialScalePoints(
  points: readonly RadialPoint[],
  center: RadialPoint,
  radius: number,
  scale: RadialScaleKey | null | undefined,
): RadialPoint[] {
  return points.map((point) => radialScalePoint(point, center, radius, scale))
}