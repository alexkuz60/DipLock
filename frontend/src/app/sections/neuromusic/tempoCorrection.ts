/**
 * Темп-коррекция радара «Эмо» (спецификация владельца 09.10.2026,
 * `docs/rules/neuromusic.md` §«Эмо», «Темп-коррекция»).
 *
 * Темп микса — из VAMP Tempo and Beat Tracker (`tempo_track` кадров
 * `GET /audio/render/{id}/emo`, `services/audio_render/vamp_analysis.py`).
 * Правила владельца:
 *
 * - ось Y графика — проекция темпа, логарифм от 2: `Y(−1) = 60 bpm`,
 *   `Y(0) = 120`, `Y(+1) = 240` → `y = clamp(log2(bpm/120), −1, +1)`;
 * - коэффициент удлинения радиусов `Kr = sin(π/2 · |y|)` («синус метки»:
 *   метка на оси трактуется как угол ±π/2, берётся синус): 60 → 1,
 *   90 → ≈0.61, 120 → 0, 240 → 1;
 * - темп < 120 → `Kr` достаётся вершинам в **нижних** квадрантах круга
 *   (угол θ ∈ [π, 2π), sin θ < 0), темп > 120 — в **верхних** (θ ∈ [0, π));
 *   новый радиус вершины `r·(1+Kr)`; вершины «чужой» половины не меняются;
 * - коррекция применяется **после** гармонической коррекции (вращение по
 *   `keyRotation`) и **до** доминант: квадрант вершины определяется её
 *   углом **после** поворота; доминанты считаются из скорректированных
 *   вершин;
 * - после коррекции — **условная нормализация**: если какой-то радиус
 *   превысил 1 (100 % R), все делятся на max (max станет = 1); если
 *   max ≤ 1 — не трогаем («дыхание» звезды по громкости сохраняется).
 *
 * Значение темпа кадра: среднее всех оценок `tempo_track`, попавших во
 * временной диапазон кадра `[t, t+hop)`; кадр без оценок держит предыдущее
 * значение (hold), до первой оценки — `null` (коррекция нулевая). В анимации
 * темп интерполируется между слайдами — плавно, как лучи и вращение.
 *
 * Чистая математика без DOM — покрыта `tempoCorrection.test.ts`;
 * применяют `radialChart.ts` (`tempoStarPolygon`) и `RadialChart.tsx`.
 */
import type { AudioEmoFrame, AudioTempoSegment } from '@/shared/api/types'

/** Нижняя граница оси темпа, bpm: Y(−1). */
export const TEMPO_MIN_BPM = 60

/** Центр оси темпа, bpm: Y(0). */
export const TEMPO_CENTER_BPM = 120

/** Верхняя граница оси темпа, bpm: Y(+1). */
export const TEMPO_MAX_BPM = 240

/**
 * Проекция темпа на ось Y: `y = clamp(log2(bpm/120), −1, +1)`.
 * 60 → −1, 120 → 0, 240 → +1; вне 60…240 зажимается к границам;
 * нечисловой/неположительный темп → 0 (нет коррекции).
 */
export function tempoY(bpm: number | null | undefined): number {
  if (bpm == null || !Number.isFinite(bpm) || bpm <= 0) return 0
  const clamped = Math.min(TEMPO_MAX_BPM, Math.max(TEMPO_MIN_BPM, bpm))
  return Math.min(1, Math.max(-1, Math.log2(clamped / TEMPO_CENTER_BPM)))
}

/**
 * Коэффициент удлинения радиусов: `Kr = sin(π/2 · |tempoY(bpm)|)` ∈ [0…1].
 * 60 → 1, 90 → ≈0.607, 120 → 0, 180 → ≈0.795, 240 → 1.
 */
export function tempoKr(bpm: number | null | undefined): number {
  return Math.sin((Math.PI / 2) * Math.abs(tempoY(bpm)))
}

/**
 * Значение темпа каждого кадра анимации: среднее оценок `tempo_track`,
 * попавших во временной диапазон кадра `[t_sec, t_sec + hopSec)`; несколько
 * оценок в диапазоне усредняются до одного (спецификация владельца).
 * Кадр без оценок держит предыдущее значение (hold), до первой оценки —
 * `null` (коррекция нулевая). Длина ряда — длина `frames`.
 */
export function frameTempos(
  tempoTrack: readonly AudioTempoSegment[] | null | undefined,
  frames: readonly Pick<AudioEmoFrame, 't_sec'>[],
  hopSec: number,
): (number | null)[] {
  const tempos = new Array<number | null>(frames.length).fill(null)
  if (!tempoTrack || tempoTrack.length === 0 || !(hopSec > 0)) return tempos
  const sorted = [...tempoTrack].sort((a, b) => a.t_sec - b.t_sec)
  let cursor = 0
  let last: number | null = null
  frames.forEach((frame, index) => {
    const start = frame.t_sec
    const end = start + hopSec
    let sum = 0
    let count = 0
    // Оценки по возрастанию времени: диапазоны кадров не убывают, курсор
    // двигается только вперёд (линейный проход по треку).
    while (cursor < sorted.length && (sorted[cursor]?.t_sec ?? Number.POSITIVE_INFINITY) < end) {
      const estimate = sorted[cursor]
      cursor += 1
      if (estimate && estimate.t_sec >= start) {
        sum += estimate.bpm
        count += 1
      }
    }
    if (count > 0) last = sum / count
    tempos[index] = last
  })
  return tempos
}

/**
 * Темп в момент `tSec`, bpm: линейная интерполяция пофреймового ряда
 * `tempos` между слайдами `floor`/`ceil` сетки `hopSec` (та же семантика
 * хвостов, что у `emoRadar.interpolatedRays` и `keyRotation`:
 * `interpolatedRotation`). `null` — темп не определён (нет ряда либо
 * текущий слайд до первой оценки) — коррекция нулевая.
 */
export function interpolatedTempo(
  tempos: readonly (number | null)[],
  frames: readonly Pick<AudioEmoFrame, 't_sec'>[],
  hopSec: number,
  tSec: number,
): number | null {
  const first = frames[0]
  if (!first || !(hopSec > 0) || tempos.length === 0) return null
  const time = Number.isFinite(tSec) ? tSec : first.t_sec
  const position = (time - first.t_sec) / hopSec
  const index = Math.min(tempos.length - 1, Math.max(0, Math.floor(position)))
  const from = tempos[index] ?? null
  const to = tempos[Math.min(tempos.length - 1, index + 1)] ?? null
  const frac = Math.min(1, Math.max(0, position - index))
  if (from === null) return null
  if (to === null) return from
  return from + (to - from) * frac
}

/**
 * Темп текстом для счётчика «Темп» у графика «Эмо»: один десятичный знак,
 * запятая как разделитель (как в подписи CSV Sonic Annotator) — «120,4 bpm».
 * `null`/нечисловой/неположительный темп — «—» (не определён).
 */
export function formatTempoBpm(bpm: number | null | undefined): string {
  if (bpm == null || !Number.isFinite(bpm) || bpm <= 0) return '—'
  return `${bpm.toFixed(1).replace('.', ',')} bpm`
}

/**
 * Темп-коррекция радиусов вершин: `r·(1+Kr)` — вершинам той половины круга,
 * куда попал их угол (`angles` — углы вершин **после** гармонического
 * вращения): при темпе < 120 — нижние квадранты (θ ∈ [π, 2π)), при > 120 —
 * верхние (θ ∈ [0, π)). Затем **условная нормализация**: если какой-то
 * радиус превысил 100 %, все делятся на max (max станет = 100 %);
 * иначе значения не трогаем. `bpm` null/нечисловой — копия без изменений.
 *
 * Значения зажимаются к 0…100 на входе (как у `starPolygon`); длина
 * `angles` должна совпадать с длиной `values`.
 */
export function tempoCorrectedRays(
  values: readonly number[],
  angles: readonly number[],
  bpm: number | null | undefined,
): number[] {
  const rays = values.map((value) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0,
  )
  const kr = tempoKr(bpm)
  if (kr <= 0) return rays
  const y = tempoY(bpm)
  rays.forEach((_, index) => {
    const angle = angles[index]
    if (angle === undefined) return
    const normalized = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
    const isLower = normalized >= Math.PI // квадранты 3–4: [π, 2π)
    if (y < 0 ? isLower : !isLower) {
      rays[index] = rays[index] * (1 + kr)
    }
  })
  const max = Math.max(...rays)
  if (max > 100) return rays.map((ray) => (ray / max) * 100)
  return rays
}