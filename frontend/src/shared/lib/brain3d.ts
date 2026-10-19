/**
 * Пространство тома fsaverage для 3D-вида «Куб» (граница пространств).
 *
 * Сервер отдаёт тома fsaverage «как есть» (`GET /surface/mri/volume/{name}`) и
 * affine `T1.mgz` в `/meta` (`mri_volumes.affine`). Здесь — только чистая
 * арифметика (без DOM) конвертации «мм MNI ↔ воксели/мировые мм»:
 *
 * * **пространство**: `fsaverage` совмещён с MNI305 (`talairach.xfm` —
 *   единичная, `docs/rules/atlas-mri.md`), поэтому миллиметры MNI и мировые
 *   миллиметры тома — одно пространство. Путь конвертации всё равно идёт явно
 *   через affine (`мми → воксели → мир`): это граница пространств в одном
 *   месте, и гард `test_real_t1_affine_matches_frontend_table` (pytest)
 *   сверяет TS-таблицу `FSAVERAGE_T1_AFFINE` с реальным томом — расхождение
 *   (другой том, сдвинутый мир) видно тестом, а не «уехавшими» диполями;
 * * **3D-вид** (`sections/dipoles/DipoleCube.tsx`) рисует в мм MNI напрямую —
 *   инвариант «мировые мм = мм MNI» (`worldEqualsMni`) делает перевод
 *   не нужным, но граница остаётся здесь: если том перестанет быть
 *   MNI-выровненным, правится один модуль, а не компоненты.
 *
 * Раньше модуль собирал ещё узлы connectome Niivue — их рисовала легенда
 * Niivue (вертикальная «колонка диполей» на канвасе). Niivue убран из вида
 * 19.10.2026 (срез 3.13), узлы удалены вместе с ним.
 */
import type { MniVector } from './mriProjections'

/**
 * Ожидаемый affine `fsaverage/mri/T1.mgz` (воксель → мировые мм, RAS).
 *
 * Дубль серверного значения (читается nibabel'ом и отдаётся в `/meta`):
 * сверяется с реальным томом тестом `tests/test_mri_volumes.py`
 * `test_real_t1_affine_matches_frontend_table` — по образцу
 * `test_geometry_matches_frontend` (константы живут в двух языках, поэтому
 * расхождение ловится чтением таблиц, а не глазами в браузере).
 *
 * Укладка тома коронарная (`L, I, A`): строка y читает ось вокселей k,
 * строка z — j; центр тома (128,128,128) → начало мира (0,0,0) — это AC,
 * и по нему же совпадают мм MNI.
 */
export const FSAVERAGE_T1_AFFINE: readonly (readonly number[])[] = [
  [-1, 0, 0, 128],
  [0, 0, 1, -128],
  [0, -1, 0, 128],
  [0, 0, 0, 1],
]

/** Affine тома из `/meta` (4×4, строками; `null` — тома нет). */
export type VolumeAffine = readonly (readonly number[])[] | null

/**
 * Применяет affine 4×4 к точке (воксель или мм) → мировые мм.
 * Невалидная матрица (не 4×4) — точка на входе: конвертация не должна
 * ронять отрисовку из-за битых метаданных.
 */
function applyAffine(
  affine: readonly (readonly number[])[],
  point: readonly [number, number, number],
): [number, number, number] {
  if (affine.length !== 4 || affine.some((row) => row.length !== 4)) return [...point]
  const [x, y, z] = point
  return [
    affine[0][0] * x + affine[0][1] * y + affine[0][2] * z + affine[0][3],
    affine[1][0] * x + affine[1][1] * y + affine[1][2] * z + affine[1][3],
    affine[2][0] * x + affine[2][1] * y + affine[2][2] * z + affine[2][3],
  ]
}

/** Обратная матрица 4×4 или `null` (вырожденный ввод — конвертировать нечего). */
function invertAffine4(m: readonly (readonly number[])[]): number[][] | null {
  const a = m.map((row) => [...row])
  const inv = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]
  const s =
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
  if (Math.abs(s) < 1e-12) return null
  // Кофакторы 3×3 для верхнего левого блока (транспонированные → обратная)
  const cof = (i: number, j: number): number => {
    const sub: number[][] = []
    for (let r = 0; r < 3; r += 1) {
      if (r === i) continue
      const line: number[] = []
      for (let c = 0; c < 3; c += 1) {
        if (c === j) continue
        line.push(a[r][c])
      }
      sub.push(line)
    }
    const det = sub[0][0] * sub[1][1] - sub[0][1] * sub[1][0]
    return (i + j) % 2 === 0 ? det : -det
  }
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      inv[j][i] = cof(i, j) / s
    }
  }
  for (let i = 0; i < 3; i += 1) {
    inv[i][3] = -(inv[i][0] * a[0][3] + inv[i][1] * a[1][3] + inv[i][2] * a[2][3])
  }
  inv[3] = [0, 0, 0, 1]
  return inv
}

/**
 * мм MNI → воксели тома (`inv(affine) · [mni; 1]`).
 *
 * Мировые мм считаются равными мм MNI (инвариант fsaverage, см. шапку модуля);
 * без affine (или при невалидной/вырожденной) — точки на входе, чтобы UI
 * работал и без тома.
 */
export function mniToVolumeVoxel(
  mni: MniVector,
  affine: VolumeAffine,
): [number, number, number] {
  if (!affine || affine.length !== 4 || affine.some((row) => row.length !== 4)) {
    return [mni.x, mni.y, mni.z]
  }
  const inv = invertAffine4(affine)
  if (inv === null) return [mni.x, mni.y, mni.z]
  return applyAffine(inv, [mni.x, mni.y, mni.z])
}

/**
 * мм MNI → мировые миллиметры тома.
 *
 * Путь «через воксели» для MNI-выровненного тома возвращает точку на месте
 * (инвариант talairach), но оставляет конвертацию явной: если том перестанет
 * быть MNI-выровненным, правится здесь, а не в нескольких компонентах.
 */
export function mniToWorldMm(mni: MniVector, affine: VolumeAffine): [number, number, number] {
  if (!affine || affine.length !== 4 || affine.some((row) => row.length !== 4)) {
    return [mni.x, mni.y, mni.z]
  }
  const inv = invertAffine4(affine)
  if (inv === null) return [mni.x, mni.y, mni.z]
  return applyAffine(affine, applyAffine(inv, [mni.x, mni.y, mni.z]))
}

/**
 * Инвариант пространства: для ожидаемого affine мировые мм совпадают с MNI
 * (talairach.fsaverage — единичная). Проверяется в Vitest на константе
 * `FSAVERAGE_T1_AFFINE` — если таблица «уехала», 3D-вид рисовал бы диполи не там.
 */
export function worldEqualsMni(
  mni: MniVector,
  affine: VolumeAffine = FSAVERAGE_T1_AFFINE,
  toleranceMm = 1e-6,
): boolean {
  const world = mniToWorldMm(mni, affine)
  return (
    Math.abs(world[0] - mni.x) <= toleranceMm &&
    Math.abs(world[1] - mni.y) <= toleranceMm &&
    Math.abs(world[2] - mni.z) <= toleranceMm
  )
}

