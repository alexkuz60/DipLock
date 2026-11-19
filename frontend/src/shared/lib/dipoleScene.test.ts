/**
 * Тесты дипольной сцены «Монтажа» на силуэте головы (срез 19.11.2026):
 * разбор sidecar, интерполяция кадров (та же семантика, что у аудио на
 * бэкенде), глубина «колодца», размер/размытие маркера, путь восьмёрки.
 */
import { describe, expect, it } from 'vitest'
import {
  depthOf,
  dipoleSceneAt,
  infinityPath,
  markerBlurPx,
  markerRadius,
  parseDipoleScene,
  type DipoleBandScene,
} from './dipoleScene'

const DEPTH_Z = { top: 70, bottom: -70 }

const BAND: DipoleBandScene = {
  stereo_base: 0.8,
  frames: [
    { t: 0, x: 0, y: 40, z: 70, theta: 0, strength: 0.5 },
    { t: 2, x: 40, y: 0, z: -70, theta: Math.PI / 2, strength: 1 },
  ],
}

describe('dipoleScene — разбор sidecar', () => {
  it('принимает валидный блок и отвергает мусор', () => {
    const valid = parseDipoleScene({
      epoch_length_ms: 500,
      mni_half_x_mm: 70,
      depth_z_mm: DEPTH_Z,
      bands: { delta: BAND },
    })
    expect(valid).not.toBeNull()
    expect(valid?.bands.delta.stereo_base).toBe(0.8)
    expect(parseDipoleScene(null)).toBeNull()
    expect(parseDipoleScene({})).toBeNull()
    expect(parseDipoleScene({ epoch_length_ms: 500 })).toBeNull()
  })
})

describe('dipoleScene — глубина и срез кадра', () => {
  it('depthOf: верх мозга → 0, низ коронарного среза → 1, зажим краёв', () => {
    expect(depthOf(70, DEPTH_Z)).toBe(0)
    expect(depthOf(-70, DEPTH_Z)).toBe(1)
    expect(depthOf(0, DEPTH_Z)).toBeCloseTo(0.5, 10)
    expect(depthOf(120, DEPTH_Z)).toBe(0)
    expect(depthOf(-120, DEPTH_Z)).toBe(1)
  })

  it('интерполяция как в playback.ts: линейно между кадрами, hold по краям', () => {
    expect(dipoleSceneAt(BAND, -1, DEPTH_Z)).toMatchObject({ x: 0, strength: 0.5 })
    expect(dipoleSceneAt(BAND, 3, DEPTH_Z)).toMatchObject({ x: 40, strength: 1 })
    const middle = dipoleSceneAt(BAND, 1, DEPTH_Z)
    expect(middle).toMatchObject({ x: 20, y: 20 })
    expect(middle?.theta).toBeCloseTo(Math.PI / 4, 10)
    expect(middle?.depth).toBeCloseTo(0.5, 10)
    // Пустая траектория — честный null.
    expect(dipoleSceneAt({ stereo_base: 0.5, frames: [] }, 0, DEPTH_Z)).toBeNull()
  })
})

describe('dipoleScene — геометрия маркера', () => {
  it('размер ∝ стереобазе (0.8 δ крупнее 0.1 γ-high), размытие ∝ глубине', () => {
    expect(markerRadius(0.8)).toBeGreaterThan(markerRadius(0.1))
    expect(markerRadius(0.8) - markerRadius(0.1)).toBeCloseTo(34 * 0.7, 10)
    expect(markerRadius(2)).toBe(markerRadius(1)) // зажим
    expect(markerBlurPx(0)).toBe(0)
    expect(markerBlurPx(1, 6)).toBe(6)
    expect(markerBlurPx(0.5, 6)).toBe(3)
  })

  it('восьмёрка: замкнутый путь через центр, симметрия относительно начала', () => {
    const path = infinityPath(10)
    expect(path.startsWith('M')).toBe(true)
    expect(path.endsWith('Z')).toBe(true)
    // Крайние точки t=0 и t=2π — правый край (∞ вытянута по X).
    expect(path.split(' ')[0]).toBe('M10.00,0.00')
    // Центр t=π/2 — точка пересечения восьмёрки (0, 0).
    expect(path).toContain('L0.00,0.00')
  })
})