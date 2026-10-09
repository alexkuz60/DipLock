/**
 * Тесты вращения звезды по тональности (спецификация владельца 09.10.2026,
 * `docs/rules/neuromusic.md` §«Эмо», «Вращение звезды»): таблица 24 кодов
 * QM Key Detector → углы, пофреймовый ряд по key_track и его линейная
 * интерполяция (плавный доворот, как у лучей).
 */
import { describe, expect, it } from 'vitest'
import type { AudioKeySegment } from '@/shared/api/types'
import {
  KEY_DELTA_RAD,
  activeKeySegment,
  frameRotations,
  interpolatedRotation,
  keyRotationRad,
} from './keyRotation'

/** Сегмент тональности — сокращение для контрольных треков. */
const seg = (tSec: number, keyCode: number): AudioKeySegment => ({
  t_sec: tSec,
  key_code: keyCode,
  label: 'test',
})

describe('keyRotationRad — таблица углов (спецификация владельца)', () => {
  it('мажор: C = 0, C# = +1δ … B = +11δ (против часовой)', () => {
    // Коды 1…12: C, C#, D, D#, E, F, F#, G, G#, A, A#, B.
    for (let steps = 0; steps <= 11; steps += 1) {
      expect(keyRotationRad(1 + steps)).toBeCloseTo(steps * KEY_DELTA_RAD, 12)
    }
    expect(keyRotationRad(1)).toBe(0) // C major
    expect(keyRotationRad(12)).toBeCloseTo(11 * KEY_DELTA_RAD, 12) // B major
  })

  it('минор: Am = 0, Abm = −1δ … Bbm = −11δ (по часовой, спуск от A)', () => {
    // Коды 13…24: Cm…Bm; шаг вниз от A: Cm=−9, Bm=−10, Bbm=−11.
    expect(keyRotationRad(22)).toBe(0) // Am
    expect(keyRotationRad(21)).toBeCloseTo(-1 * KEY_DELTA_RAD, 12) // Abm
    expect(keyRotationRad(20)).toBeCloseTo(-2 * KEY_DELTA_RAD, 12) // Gm
    expect(keyRotationRad(19)).toBeCloseTo(-3 * KEY_DELTA_RAD, 12) // Gbm
    expect(keyRotationRad(18)).toBeCloseTo(-4 * KEY_DELTA_RAD, 12) // Fm
    expect(keyRotationRad(17)).toBeCloseTo(-5 * KEY_DELTA_RAD, 12) // Fbm = Em
    expect(keyRotationRad(16)).toBeCloseTo(-6 * KEY_DELTA_RAD, 12) // Ebm
    expect(keyRotationRad(15)).toBeCloseTo(-7 * KEY_DELTA_RAD, 12) // Dm
    expect(keyRotationRad(14)).toBeCloseTo(-8 * KEY_DELTA_RAD, 12) // Dbm
    expect(keyRotationRad(13)).toBeCloseTo(-9 * KEY_DELTA_RAD, 12) // Cm
    expect(keyRotationRad(24)).toBeCloseTo(-10 * KEY_DELTA_RAD, 12) // Bm
    expect(keyRotationRad(23)).toBeCloseTo(-11 * KEY_DELTA_RAD, 12) // Bbm
  })

  it('δ = π/42 (1/12 сектора из 7), код вне 1…24 — 0', () => {
    expect(KEY_DELTA_RAD).toBeCloseTo(Math.PI / 42, 12)
    expect(keyRotationRad(0)).toBe(0)
    expect(keyRotationRad(25)).toBe(0)
    expect(keyRotationRad(Number.NaN)).toBe(0)
    expect(keyRotationRad(1.4)).toBeCloseTo(0 * KEY_DELTA_RAD, 12) // округление → C
  })
})

describe('frameRotations — угол кадра из активного сегмента', () => {
  it('сегмент длится до следующего; до первого сегмента — 0', () => {
    const track = [seg(0, 12), seg(2, 22)] // B major (+11δ) → Am (0)
    const frames = [{ t_sec: 0 }, { t_sec: 1 }, { t_sec: 2 }, { t_sec: 3 }]
    const rotations = frameRotations(track, frames)
    expect(rotations).toHaveLength(4)
    expect(rotations[0]).toBeCloseTo(11 * KEY_DELTA_RAD, 12)
    expect(rotations[1]).toBeCloseTo(11 * KEY_DELTA_RAD, 12)
    expect(rotations[2]).toBe(0)
    expect(rotations[3]).toBe(0)
    // Первый сегмент не с нуля: кадры до него без вращения.
    const late = frameRotations([seg(5, 1)], [{ t_sec: 0 }, { t_sec: 5 }])
    expect(late[0]).toBe(0)
    expect(late[1]).toBe(0) // C major = 0
  })

  it('нет трека — нули на все кадры (вращение выключено)', () => {
    const frames = [{ t_sec: 0 }, { t_sec: 1 }]
    expect(frameRotations(null, frames)).toEqual([0, 0])
    expect(frameRotations([], frames)).toEqual([0, 0])
    expect(frameRotations(null, [])).toEqual([])
  })
})

describe('interpolatedRotation — плавный доворот между кадрами', () => {
  const rotations = [0, 10 * KEY_DELTA_RAD, 10 * KEY_DELTA_RAD]
  const frames = [{ t_sec: 0 }, { t_sec: 2 / 3 }, { t_sec: 4 / 3 }]
  const hop = 2 / 3

  it('на границе слайда — точный угол кадра', () => {
    expect(interpolatedRotation(rotations, frames, hop, 0)).toBeCloseTo(0, 12)
    expect(interpolatedRotation(rotations, frames, hop, hop)).toBeCloseTo(
      10 * KEY_DELTA_RAD,
      12,
    )
  })

  it('внутри слайда — линейная интерполяция (плавно, без рывка)', () => {
    const mid = interpolatedRotation(rotations, frames, hop, hop / 2)
    expect(mid).toBeCloseTo(5 * KEY_DELTA_RAD, 12)
  })

  it('хвосты держатся; нет ряда/сетки — null', () => {
    expect(interpolatedRotation(rotations, frames, hop, -1)).toBeCloseTo(0, 12)
    expect(interpolatedRotation(rotations, frames, hop, 1000)).toBeCloseTo(
      10 * KEY_DELTA_RAD,
      12,
    )
    expect(interpolatedRotation([], frames, hop, 0)).toBeNull()
    expect(interpolatedRotation(rotations, [], hop, 0)).toBeNull()
    expect(interpolatedRotation(rotations, frames, 0, 0)).toBeNull()
  })

describe('activeKeySegment — активный сегмент тональности (счётчик «Аккорд»)', () => {
  const track = [seg(0, 1), seg(2, 13), seg(3.5, 5)]

  it('hold до следующего сегмента; граница t_sec включительно', () => {
    expect(activeKeySegment(track, 0)?.key_code).toBe(1)
    expect(activeKeySegment(track, 1.9)?.key_code).toBe(1)
    expect(activeKeySegment(track, 2)?.key_code).toBe(13)
    expect(activeKeySegment(track, 3.4)?.key_code).toBe(13)
    expect(activeKeySegment(track, 100)?.key_code).toBe(5)
  })

  it('до первого сегмента, пустой/отсутствующий трек, мусорное время — null', () => {
    const late = [seg(1, 1)]
    expect(activeKeySegment(late, 0.5)).toBeNull()
    expect(activeKeySegment([], 1)).toBeNull()
    expect(activeKeySegment(null, 1)).toBeNull()
    expect(activeKeySegment(undefined, 1)).toBeNull()
    expect(activeKeySegment(track, Number.NaN)).toBeNull()
  })
})
})