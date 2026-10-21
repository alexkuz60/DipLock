/**
 * Математика графика «Эмограмма» (постановка владельца 21.10.2026): лучи
 * полигона-звезды, развернутые по шкале времени аудиотрека.
 *
 * Эмограмма — таб секции «Визуализация» раздела «ЕмоЛаб» (рядом с табом
 * «Звезда», позже — новые аналитические графики) и строится из тех
 * же данных кадров «Эмо» (после динамического диапазона, гармонического
 * вращения и темп-коррекции — ровно те доминанты кадров, что рисует облако
 * `radialChart.dominantCloud`). В её пространстве два графика:
 *
 * * **Экспрессия Эмо** — вертикальные столбики от низа до значения
 *   радиус-вектора доминанты кадра: шкала Y 0…1 в динамическом диапазоне
 *   радиус-векторов (`radiusFrac` = |r|/R, доминанта зажата к кругу-границе);
 *   цвет столбика — **сектор Эмо** его угла (правка владельца: тот же цвет
 *   сектора, что у ступени кадра).
 * * **Динамика Эмо** — горизонтальные линии-ступени длиной 1 с (1 кадр
 *   анимации звезды): координата Y берётся из угла доминанты кадра —
 *   от начала 1 сектора звезды (`SEGMENT_START` = π/2 + π/7) против часовой
 *   на полный круг 2π. Цвет ступени — цвет сектора радара, в котором лежит
 *   угол (`radialChart.SECTOR_COLORS`).
 *
 * Шкала Y справа «Эмо»: 14 текстовых значений снизу вверх
 * (`EMO_LABELS`: страх → агрессия) и 14 горизонтальных линий разметки с
 * шагом **π/7** по углу (14 · π/7 = 2π): линия i стоит на угле
 * `SEGMENT_START + i·π/7`, «страх» — внизу (совпадает с началом 1 сектора),
 * шов круга (между «агрессией» и «страхом») — у верхней кромки графика.
 * Каждый цвет сектора радара (2π/7) покрывает ровно **2 эмоции**.
 *
 * Чистая математика без DOM — покрыта `emogram.test.ts`; рисует
 * `emolab/Emogram.tsx`.
 */
import { SEGMENT_START, dominantCloud, sectorIndexOf } from '../neuromusic/radialChart'

/**
 * 14 эмоций шкалы Y «Эмо», **снизу вверх**: страх → агрессия. Линия i стоит
 * на `i/14` высоты графика (угол `SEGMENT_START + i·π/7`).
 */
export const EMO_LABELS: readonly string[] = [
  'страх',
  'трагедия',
  'скорбь',
  'отвращение',
  'депрессия',
  'смирение',
  'безразличие',
  'интерес',
  'уверенность',
  'радость',
  'энтузиазм',
  'вдохновение',
  'эйфория',
  'агрессия',
]

/** Дефолтная ширина SVG, px (jsdom и до замера `ResizeObserver`). */
export const EMO_VIEW_W = 640

/** Дефолтная высота SVG, px (jsdom и до замера `ResizeObserver`). */
export const EMO_VIEW_H = 200

/** Левое поле графика, px. */
export const EMO_PAD_LEFT = 8

/** Верхнее поле графика, px. */
export const EMO_PAD_TOP = 8

/** Ширина правого столбца подписей шкалы Y «Эмо», px. */
export const EMO_LABEL_W = 96

/** Высота нижнего поля подписей шкалы времени, px. */
export const EMO_TIME_H = 18

/** Зазор между столбиками «Экспрессии Эмо», px (смежные кадры не слипаются). */
export const EMO_BAR_GAP_PX = 1

/** Нормализация угла в диапазон [0, 2π): отрицательные и за кругом приводятся. */
function normalizeAngle(angleRad: number): number {
  const full = 2 * Math.PI
  return ((angleRad % full) + full) % full
}

/**
 * Доля высоты графика для угла доминанты, 0…1: **0 — низ** (угол
 * `SEGMENT_START` = π/2 + π/7, начало 1 сектора звезды), далее против
 * часовой на полный круг 2π (`1` — тот же угол через круг, шов у верха).
 * Нечисловой угол — 0 (низ).
 */
export function emoAngleFraction(angleRad: number): number {
  if (!Number.isFinite(angleRad)) return 0
  return normalizeAngle(angleRad - SEGMENT_START) / (2 * Math.PI)
}

/**
 * X момента `tSec` внутри графика шириной `plotWidth`, px: линейная шкала
 * времени `[0 … durationSec]` → `[0 … plotWidth]`, вне диапазона — зажим к
 * кромкам; негодная длительность/ширина — 0.
 */
export function emoTimeX(tSec: number, durationSec: number, plotWidth: number): number {
  if (!(durationSec > 0) || !(plotWidth > 0)) return 0
  const time = Number.isFinite(tSec) ? Math.min(durationSec, Math.max(0, tSec)) : 0
  return (time / durationSec) * plotWidth
}

/** Кадр «Эмо» для серии доминант: лучи + углы его вращения/темпа. */
export type EmoFrameInput = {
  /** Время кадра, с */
  readonly tSec: number
  /** Лучи кадра, % радиуса (0…100, уже в динамическом диапазоне шкалы) */
  readonly rays: readonly number[]
  /** Угол вращения полигона кадра, рад (0 — без поворота) */
  readonly rotation?: number
  /** Темп кадра, bpm (null — без темп-коррекции) */
  readonly tempo?: number | null
}

/** Доминанта кадра в полярных координатах Эмограммы. */
export type EmoDominant = {
  /** Время кадра, с */
  readonly tSec: number
  /** Радиус-вектор доминанты, доли R (0…1; зажим `dominantPoint`) */
  readonly radiusFrac: number
  /** Угол доминанты, рад, нормализован в [0, 2π) (при radiusFrac = 0 не определён) */
  readonly angleRad: number
}

/**
 * Доминанты кадров в полярных координатах — **те же точки**, что облако
 * доминант звезды (`dominantCloud` на единичном круге): лучи кадра →
 * гармоническое вращение → темп-коррекция → вершины → сумма компонент.
 * Точка центра (тишина, равные лучи) — `radiusFrac` 0, угол не определён.
 */
export function dominantSeries(frames: readonly EmoFrameInput[]): EmoDominant[] {
  const points = dominantCloud(
    frames.map(({ rays, rotation, tempo }) => ({ rays, rotation, tempo })),
    1,
    { x: 0, y: 0 },
  )
  return frames.map((frame, index) => {
    const point = points[index] ?? { x: 0, y: 0 }
    // SVG y вниз, угол математический — от +X против часовой.
    return {
      tSec: frame.tSec,
      radiusFrac: Math.min(1, Math.max(0, Math.hypot(point.x, point.y))),
      angleRad: normalizeAngle(Math.atan2(-point.y, point.x)),
    }
  })
}

/** Столбик «Экспрессии Эмо»: x = `[tSec, tSec+lenSec]`, высота = радиус-вектор. */
export type EmoBar = {
  /** Начало столбика (время кадра), с */
  readonly tSec: number
  /** Длина столбика по шкале времени (1 кадр), с */
  readonly lenSec: number
  /** Высота столбика, доли высоты графика (0…1) */
  readonly height: number
  /** Индекс сектора Эмо угла доминанты (0…6 → цвет `SECTOR_COLORS`) */
  readonly sector: number
}

/** Ступень «Динамики Эмо»: горизонталь `[tSec, tSec+lenSec]` на высоте угла. */
export type EmoStep = {
  /** Начало ступени (время кадра), с */
  readonly tSec: number
  /** Длина ступени по шкале времени (1 кадр = 1 с), с */
  readonly lenSec: number
  /** Высота ступени, доли высоты графика (0…1; 0 — низ, «страх») */
  readonly yFrac: number
  /** Индекс сектора радара угла ступени (0…6 → цвет `SECTOR_COLORS`) */
  readonly sector: number
}

/**
 * Столбики «Экспрессии Эмо»: по одному на кадр, высота = `radiusFrac`
 * доминанты (0…1 динамического диапазона радиус-векторов), цвет = сектор Эмо
 * её угла (`sectorIndexOf` — тот же сектор, что у ступени кадра). Кадры без
 * радиус-вектора (тишина — доминанта в центре) не рисуются (столбик нулевой
 * высоты не виден). `frameSec` — длина кадра по шкале времени (1 с).
 */
export function emoBars(series: readonly EmoDominant[], frameSec: number): EmoBar[] {
  const lenSec = frameSec > 0 && Number.isFinite(frameSec) ? frameSec : 0
  return series
    .filter((point) => point.radiusFrac > 0)
    .map((point) => ({
      tSec: point.tSec,
      lenSec,
      height: point.radiusFrac,
      sector: sectorIndexOf(point.angleRad),
    }))
}

/**
 * Ступени «Динамики Эмо»: по одной на кадр, длина `frameSec` (1 с = кадр
 * анимации звезды), высота — из угла доминанты (`emoAngleFraction`), цвет —
 * сектор радара этого угла (`sectorIndexOf`). Кадры без радиус-вектора
 * (угол не определён) не рисуются.
 */
export function emoSteps(series: readonly EmoDominant[], frameSec: number): EmoStep[] {
  const lenSec = frameSec > 0 && Number.isFinite(frameSec) ? frameSec : 0
  return series
    .filter((point) => point.radiusFrac > 0)
    .map((point) => ({
      tSec: point.tSec,
      lenSec,
      yFrac: emoAngleFraction(point.angleRad),
      sector: sectorIndexOf(point.angleRad),
    }))
}