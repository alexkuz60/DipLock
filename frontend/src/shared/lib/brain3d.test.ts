/**
 * Тесты границы пространств 3D-вида (`shared/lib/brain3d.ts`): affine тома и
 * инвариант `worldEqualsMni` — мировые мм тома обязаны совпадать с мм MNI
 * (talairach единичная), иначе диполи в 3D «уезжают» относительно проекций.
 */
import { describe, expect, it } from 'vitest'
import {
  FSAVERAGE_T1_AFFINE,
  mniToVolumeVoxel,
  mniToWorldMm,
  worldEqualsMni,
} from './brain3d'

describe('brain3d: пространство тома', () => {
  it('мировые мм совпадают с MNI для ожидаемого affine (инвариант talairach)', () => {
    for (const point of [
      { x: 0, y: 0, z: 0 },
      { x: -42, y: -18, z: 16 },
      { x: 70, y: -110, z: -80 },
      { x: -80, y: 80, z: 90 },
    ]) {
      expect(worldEqualsMni(point), `точка ${JSON.stringify(point)} «уехала»`).toBe(true)
    }
  })

  it('центр тома (воксель 128,128,128) — начало мира (AC)', () => {
    expect(mniToWorldMm({ x: 0, y: 0, z: 0 }, FSAVERAGE_T1_AFFINE)).toEqual([0, 0, 0])
  })

  it('мми MNI → воксели: коронарная укладка (строки y/z читают j/k)', () => {
    // Воксель (0,0,0) тома → мир (128,-128,128): MNI (128,-128,128) → воксель (0,0,0)
    expect(mniToVolumeVoxel({ x: 128, y: -128, z: 128 }, FSAVERAGE_T1_AFFINE)).toEqual([0, 0, 0])
    // И обратно: воксель (128,128,128) — центр → AC
    expect(mniToVolumeVoxel({ x: 0, y: 0, z: 0 }, FSAVERAGE_T1_AFFINE)).toEqual([128, 128, 128])
  })

  it('без affine — точки на входе (UI работает без тома)', () => {
    expect(mniToWorldMm({ x: 5, y: -3, z: 7 }, null)).toEqual([5, -3, 7])
    expect(mniToVolumeVoxel({ x: 5, y: -3, z: 7 }, null)).toEqual([5, -3, 7])
  })

  it('вырожденная матрица — не роняет конвертацию (точки на входе)', () => {
    const degenerate = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 1],
    ]
    expect(mniToWorldMm({ x: 1, y: 2, z: 3 }, degenerate)).toEqual([1, 2, 3])
  })
})
