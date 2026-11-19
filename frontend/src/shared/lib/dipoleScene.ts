/**
 * Дипольная сцена «Монтажа» на силуэте головы (вид сверху) — чистая математика
 * без DOM и zustand (как `playback.ts`/`radialChart.ts`).
 *
 * Источник — блок `extensions.dipoles` sidecar рендера
 * (`backend/app/services/audio_render/dipole_scene.py`): кадры «эпоха ×
 * полоса» с позицией MNI, углом момента θ и силой диполя. Отображение
 * (спецификация владельца 19.11.2026, во время плей):
 *
 * * **форма** — вращающаяся вокруг собственного центра восьмёрка (∞) по θ;
 * * **цвет** — цвет частотной полосы (`shared/lib/bandColors`);
 * * **размер** — ширина стереозоны полосы (0.8 δ → 0.1 γ-high);
 * * **прозрачность заливки** — сила диполя (strength 0..1);
 * * **размытость границы окружности** — глубина (uход z вниз по коронарному
 *   срезу: `depthOf`, тот же расчёт, что в звуке «колодца»).
 *
 * Интерполяция кадров повторяет аудио (`band_series` на бэкенде): между
 * измеренными кадрами линейно, до первой/после последней — hold.
 */

/** Один измеренный кадр траектории полосы. */
export type DipoleSceneFrame = {
  /** Момент кадра от начала записи, с (сетка эпох). */
  t: number
  /** Позиция диполя, мм MNI (x — лево/право, y — перед/зад). */
  x: number
  y: number
  z: number
  /** Непрерывный азимут момента, рад (развёрнутый, без скачков ±π). */
  theta: number
  /** Сила диполя 0..1 (амплитуда, нормированная по пику полосы). */
  strength: number
}

/** Сцена одной полосы: стереобаза (размер ∞) + кадры траектории. */
export type DipoleBandScene = {
  stereo_base: number
  frames: DipoleSceneFrame[]
}

/** Блок `extensions.dipoles` sidecar. */
export type DipoleScene = {
  source_job_id?: string | null
  epoch_length_ms: number
  mni_half_x_mm: number
  depth_z_mm: { top: number; bottom: number }
  bands: Record<string, DipoleBandScene>
}

/** Срез сцены полосы в момент времени (параметры маркера ∞). */
export type DipoleSceneSample = {
  x: number
  y: number
  z: number
  theta: number
  strength: number
  /** Глубина «колодца» 0..1 — размытость границы окружности. */
  depth: number
}

/** Разбор блока sidecar: `null` — нет данных или мусор (UI без маркеров). */
export function parseDipoleScene(value: unknown): DipoleScene | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Partial<DipoleScene>
  if (typeof raw.epoch_length_ms !== 'number' || typeof raw.mni_half_x_mm !== 'number') {
    return null
  }
  if (typeof raw.depth_z_mm !== 'object' || raw.depth_z_mm === null) return null
  if (typeof raw.bands !== 'object' || raw.bands === null) return null
  return {
    source_job_id: raw.source_job_id ?? null,
    epoch_length_ms: raw.epoch_length_ms,
    mni_half_x_mm: raw.mni_half_x_mm,
    depth_z_mm: raw.depth_z_mm,
    bands: raw.bands,
  }
}

/** Глубина «колодца» по z MNI: верх мозга → 0, низ коронарного среза → 1. */
export function depthOf(z: number, depthZ: { top: number; bottom: number }): number {
  const span = depthZ.top - depthZ.bottom
  if (span === 0) return 0
  const depth = (depthZ.top - z) / span
  return Math.min(1, Math.max(0, depth))
}

/**
 * Срез полосы в момент `tSec`: линейная интерполяция между измеренными
 * кадрами, hold до первой/после последней (семантика playback.ts).
 */
export function dipoleSceneAt(
  band: DipoleBandScene,
  tSec: number,
  depthZ: { top: number; bottom: number },
): DipoleSceneSample | null {
  const frames = band.frames
  if (!frames || frames.length === 0) return null
  let sample: DipoleSceneFrame
  if (tSec <= frames[0].t) {
    sample = frames[0]
  } else if (tSec >= frames[frames.length - 1].t) {
    sample = frames[frames.length - 1]
  } else {
    let index = 1
    while (index < frames.length && frames[index].t < tSec) index += 1
    const before = frames[index - 1]
    const after = frames[index]
    const span = after.t - before.t
    const k = span > 0 ? (tSec - before.t) / span : 0
    sample = {
      t: tSec,
      x: before.x + (after.x - before.x) * k,
      y: before.y + (after.y - before.y) * k,
      z: before.z + (after.z - before.z) * k,
      theta: before.theta + (after.theta - before.theta) * k,
      strength: before.strength + (after.strength - before.strength) * k,
    }
  }
  return {
    x: sample.x,
    y: sample.y,
    z: sample.z,
    theta: sample.theta,
    strength: Math.min(1, Math.max(0, sample.strength)),
    depth: depthOf(sample.z, depthZ),
  }
}

/** Радиус восьмёрки (px viewBox) ∝ стереобазе полосы: 0.8 δ крупнее 0.1 γ-high. */
export function markerRadius(stereoBase: number): number {
  return 10 + 34 * Math.min(1, Math.max(0, stereoBase))
}

/** Размытость границы окружности (px) ∝ глубине «колодца». */
export function markerBlurPx(depth: number, maxBlurPx = 6): number {
  return Math.min(1, Math.max(0, depth)) * maxBlurPx
}

/**
 * Путь восьмёрки (∞, лемниската Бернулли) вокруг (0, 0) с «радиусом» size —
 * для `<path d=…>` внутри `<g transform="translate(cx, cy) rotate(deg)">`.
 */
export function infinityPath(size: number, samples = 64): string {
  const points: string[] = []
  for (let index = 0; index <= samples; index += 1) {
    const t = (index / samples) * Math.PI * 2
    const denominator = 1 + Math.sin(t) ** 2
    const x = (size * Math.cos(t)) / denominator
    const y = (size * Math.sin(t) * Math.cos(t)) / denominator
    points.push(`${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`)
  }
  return `${points.join(' ')} Z`
}