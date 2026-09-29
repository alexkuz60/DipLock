/**
 * Тесты пространства 3D-вида (срез 3.5): affine, URL томов, узлы диполей.
 *
 * Главный инвариант — `worldEqualsMni`: мировые мм тома и мм MNI обязаны
 * совпадать для ожидаемого affine (talairach единичная), иначе диполи в 3D
 * «уезжают» относительно проекций.
 */
import { describe, expect, it } from 'vitest'
import {
  FSAVERAGE_T1_AFFINE,
  connectomeNodes,
  mniToVolumeVoxel,
  mniToWorldMm,
  nodeColorScale,
  t1VolumeUrl,
  volumeUrl,
  worldEqualsMni,
} from './brain3d'
import type { DipoleLayer } from './dipolePoints'
import type { MriVolumeRef } from '@/shared/api/types'

const REF: MriVolumeRef = {
  version: 'vol12345678',
  url: '/api/v1/surface/mri/volume',
  names: ['T1.mgz', 'seghead.mgz', 'lh.white', 'rh.white'],
  affine: FSAVERAGE_T1_AFFINE.map((row) => [...row]),
}

function layerOf(points: DipoleLayer['points']): DipoleLayer {
  return { points, source: 'result' }
}

const POINT = {
  id: '1-100',
  epochIndex: 0,
  timeMs: 100,
  position: { x: -42, y: -18, z: 16 } as const,
  orientation: { x: 0, y: 0, z: 1 } as const,
  amplitudeNaM: 12,
  gof: 0.9,
  brodmannArea: null,
  structure: null,
  structureDistanceMm: null,
  areaDistanceMm: null,
  outsideBrain: null,
}

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

describe('brain3d: URL томов', () => {
  it('URL тома несёт имя из белого списка и версию отпечатка', () => {
    expect(volumeUrl(REF, 'seghead.mgz')).toBe(
      '/api/v1/surface/mri/volume/seghead.mgz?v=vol12345678',
    )
    expect(t1VolumeUrl(REF)).toBe('/api/v1/surface/mri/volume/T1.mgz?v=vol12345678')
  })
})

describe('brain3d: узлы диполей', () => {
  it('узлы в мировых мм, цвет нормирован по шкале слоя', () => {
    const layer = layerOf([
      { ...POINT },
      { ...POINT, id: '2-200', epochIndex: 1, amplitudeNaM: 20, position: { x: 40, y: 0, z: 0 } },
    ])
    const scale = nodeColorScale(layer)
    expect(scale).toEqual({ min: 12, max: 20 })

    const nodes = connectomeNodes(layer, FSAVERAGE_T1_AFFINE, scale)
    expect(nodes).toHaveLength(2)
    expect(nodes[0]).toMatchObject({ x: -42, y: -18, z: 16, colorValue: 0, sizeValue: 1 })
    expect(nodes[1].colorValue).toBe(1)
  })

  it('пустой слой — пустая шкала (0..1) и пустые узлы', () => {
    expect(nodeColorScale(layerOf([]))).toEqual({ min: 0, max: 1 })
    expect(connectomeNodes(layerOf([]), FSAVERAGE_T1_AFFINE, { min: 0, max: 1 })).toEqual([])
  })

  it('точки с NaN-координатами отбрасываются', () => {
    const layer = layerOf([
      { ...POINT, position: { x: Number.NaN, y: 0, z: 0 } },
      { ...POINT, id: '2-200' },
    ])
    expect(connectomeNodes(layer, FSAVERAGE_T1_AFFINE, { min: 0, max: 1 })).toHaveLength(1)
  })
})
