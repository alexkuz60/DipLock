/**
 * Тики ½ сектора и надписи классификатора эмоций вокруг радара-звезды
 * (постановка владельца 27.10.2026): круг-граница размечается засечками с
 * шагом **π/7 = ½ сектора** — 14 позиций `SEGMENT_START + i·π/7` (границы
 * 14 эмо-категорий «Эмограммы»), снаружи по кругу — 14 надписей
 * классификатора (`EMO_LABELS` «страх/агрессия» … «эйфория»), каждая с зазором
 * **10 px** от окружности: ближайшая точка текст-бокса стоит не ближе
 * 10 px к кругу при любом угле и ширине текста — надписи окружность **не
 * перекрывают**.
 *
 * Правка 27.10.2026 (2): кегль надписей **12 px**, вертикальные надписи
 * («агрессия» вверх, «безразличие» вниз) отодвинуты ещё на **5 px**
 * (`LABEL_SHIFT_PX`), а viewBox стал **адаптивным** (`radialFrameLayout`):
 * круг занимает максимум ячейки за вычетом полей под надписи — диаметр
 * круга ≈ высоте соседней гистограммы (постановка «увеличить в 2 раза»).
 * Правка 30.10.2026 (классификатор Рассела): надписи — `EMO_LABELS`
 * «страх/агрессия» … «эйфория» (верх π/2 — «эйфория», низ 3π/2 —
 * «безразличие»), худший выступ сместился на «уверенность».
 *
 * Чистая математика без DOM (углы → точки SVG, px → единицы viewBox через
 * `pxPerUnit`) — покрыта `emoTicks.test.ts`; рисует `RadialChart.tsx`
 * (обе секции: «Нейромузыка» и «ЕмоЛаб» → таб «Звезда»).
 */

import { SEGMENT_START, type RadialPoint } from './radialChart'

/**
 * Число тиков = число надписей классификатора = 14 эмо-категорий
 * (`EMO_LABELS`): ровно по две на каждый из 7 секторов радара.
 */
export const EMO_TICK_COUNT = 14

/** Шаг тика, рад: 2π/14 = π/7 = половина сектора (`SEGMENT_STEP` / 2). */
export const EMO_TICK_STEP = (2 * Math.PI) / EMO_TICK_COUNT

/** Зазор надписи от окружности, px (требование владельца «10 пиксел»). */
export const LABEL_GAP_PX = 10

/**
 * Кегль надписи, px (экранно-пиксельный, как точки ⌀8/10 px радара).
 * Правка 27.10.2026 (2): 9 → 12 px («шрифт надписей можно увеличить»).
 */
export const LABEL_FONT_PX = 12

/**
 * Дополнительный радиальный сдвиг **вертикальных** надписей, px (правка
 * 27.10.2026 (2): «поднять выше на 5 пиксел "Агрессия" и опустить на 5
 * пиксел "Безразличие"»). Вертикальные = строго на вертикали круга
 * (`|cos θ| < 1e-9`): i = 13 (θ = π/2 — верх, сдвиг вверх; с 30.10.2026 это
 * «эйфория», тогда — «агрессия») и i = 6 «безразличие» (θ = 3π/2 — низ,
 * сдвиг вниз) — обе наружу от центра, их зазор до окружности становится 15 px.
 */
export const LABEL_SHIFT_PX = 5

/** Полудлина тика от окружности, px (тик = 6 px: 3 внутрь + 3 наружу). */
export const TICK_HALF_PX = 3

/** Оценка ширины строчного текста, em на знак (кириллица, без замера DOM). */
const LABEL_WIDTH_EM = 0.62

/** Полная высота строки надписи, em (box выше кегля — с запасом на спуски). */
const LABEL_LINE_EM = 1.2

/** Надпись классификатора в координатах SVG. */
export type EmoLabelPlacement = {
  /** Текст надписи (`EMO_LABELS[i]`) */
  label: string
  /** x центра текст-бокса в единицах viewBox */
  x: number
  /** y центра текст-бокса в единицах viewBox */
  y: number
}

/** Кадр отрисовки радара: viewBox под ячейку + масштаб px/единицу. */
export type RadialFrame = {
  /** viewBox SVG: подогнан под ячейку, центр графика — (100, 100) */
  viewBox: string
  /** Масштаб: CSS-пикселей экрана на единицу viewBox */
  pxPerUnit: number
}

/** Текст-бокс надписи в px: позиция по тику + полуразмеры box'а. */
type LabelBox = {
  /** Угол тика надписи, рад */
  angle: number
  /** Полуширина box'а, px */
  halfW: number
  /** Полувысота box'а, px */
  halfH: number
  /** Дополнительный радиальный сдвиг (вертикальные надписи), px */
  shift: number
}

/** Текст-боксы надписей по их тикам (общий источник раскладки и кадра). */
function labelBoxes(labels: readonly string[]): LabelBox[] {
  const angles = emoTickAngles()
  return labels.map((label, index) => {
    const angle = angles[index % angles.length]
    return {
      angle,
      halfW: estimateTextWidthPx(label) / 2,
      halfH: (LABEL_FONT_PX * LABEL_LINE_EM) / 2,
      shift: Math.abs(Math.cos(angle)) < 1e-9 ? LABEL_SHIFT_PX : 0,
    }
  })
}

/**
 * Углы тиков-засечек, рад: `SEGMENT_START + i·2π/14`, i = 0…13 — границы
 * эмо-категорий `emolab/emogram.emoCategoryIndex` (категория i начинается на
 * тике i; «страх/агрессия» — на начале 1 сектора звезды, как шкала Y
 * «Эмограммы»).
 */
export function emoTickAngles(): number[] {
  return Array.from({ length: EMO_TICK_COUNT }, (_, index) => SEGMENT_START + index * EMO_TICK_STEP)
}

/**
 * Оценка ширины текста надписи, px: `длина · кегль · 0.62 em` — честный
 * замер (`getComputedTextLength`) в jsdom недоступен; оценка намеренно
 * шире типичной кириллицы (0.5–0.55 em), зазор до окружности от этого
 * только растёт.
 */
export function estimateTextWidthPx(text: string): number {
  return text.length * LABEL_FONT_PX * LABEL_WIDTH_EM
}

/**
 * Раскладка надписей классификатора по кругу радара: подпись i стоит на
 * радиусе тика i (`emoTickAngles`), центр её текст-бокса — снаружи круга
 * `radius` с зазором `LABEL_GAP_PX` px (единицы viewBox: px / `pxPerUnit`,
 * приём точек ⌀8/10 px радара).
 *
 * Гарантия «не наезжает»: центр box'а отстоит от центра на
 * `radius + (gap + halfW·|cosθ| + halfH·|sinθ| + shift)/pxPerUnit`, а
 * support-функция box'а по направлению к центру равна `halfW·|cosθ| + halfH·|sinθ|` — значит
 * ближайшая точка box'а к окружности ≥ gap px (у вертикальных ≥ gap + shift)
 * при любом угле θ.
 */
export function emoLabelLayout(
  labels: readonly string[],
  radius: number,
  center: RadialPoint,
  pxPerUnit: number,
): EmoLabelPlacement[] {
  const scale = pxPerUnit > 0 ? pxPerUnit : 1
  return labelBoxes(labels).map((box, index) => {
    const pullPx =
      LABEL_GAP_PX +
      box.halfW * Math.abs(Math.cos(box.angle)) +
      box.halfH * Math.abs(Math.sin(box.angle)) +
      box.shift
    const distance = radius + pullPx / scale
    return {
      label: labels[index],
      x: center.x + distance * Math.cos(box.angle),
      y: center.y - distance * Math.sin(box.angle),
    }
  })
}

/** Округление до сотых — стабильные строки viewBox в атрибуте. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Кадр отрисовки радара под ячейку `wPx × hPx` (правка 27.10.2026 (2),
 * «круги до высоты гистограммы»): **адаптивный viewBox** — круг занимает
 * максимум ячейки за вычетом полей под надписи.
 *
 * Масштаб `pxPerUnit = s` максимален, при котором все надписи умещаются в
 * ячейку: выступ box'а надписи по оси X — `(radius·s + pull)·|cosθ| + halfW`
 * (по Y — `sin`/`halfH`), обе величины ≤ половины стороны ячейки. Отсюда
 * замкнутая форма `s ≤ (span/2 − edge − pull·lead) / (radius·lead)` по каждой
 * надписи и оси; итоговый `s` — минимум, ещё ограничен вписыванием самого
 * круга. viewBox подгоняется под ячейку **точно** по её пропорциям (центр —
 * (100, 100), `preserveAspectRatio` с `meet` заполняет ячейку без полей).
 *
 * Одинаков у радара и «квинтового круга» (`emolab/CircleOfFifths.tsx`) при
 * равных ячейках — инварианта «диаметр звезды = диаметр круга» сохранена.
 *
 * Без замера (jsdom, `wPx = hPx = 0`): масштаб 1 и квадратный viewBox по
 * худшему выступу надписей — тесты видят «честные» пиксели.
 */
export function radialFrameLayout(
  labels: readonly string[],
  wPx: number,
  hPx: number,
  radius: number,
): RadialFrame {
  const boxes = labelBoxes(labels)
  /** Выступ box'а за центр по оси X/Y при масштабе `scale`, px. */
  const extent = (box: LabelBox, scale: number, axis: 'x' | 'y'): number => {
    const cos = Math.abs(Math.cos(box.angle))
    const sin = Math.abs(Math.sin(box.angle))
    const pull = LABEL_GAP_PX + box.halfW * cos + box.halfH * sin + box.shift
    return axis === 'x'
      ? (radius * scale + pull) * cos + box.halfW
      : (radius * scale + pull) * sin + box.halfH
  }
  if (!(wPx > 0 && hPx > 0)) {
    let half = radius
    for (const box of boxes) {
      half = Math.max(half, extent(box, 1, 'x'), extent(box, 1, 'y'))
    }
    const size = Math.ceil(half)
    return { viewBox: `${100 - size} ${100 - size} ${2 * size} ${2 * size}`, pxPerUnit: 1 }
  }
  let scale = Math.min(wPx, hPx) / (2 * radius)
  for (const box of boxes) {
    const cos = Math.abs(Math.cos(box.angle))
    const sin = Math.abs(Math.sin(box.angle))
    const pull = LABEL_GAP_PX + box.halfW * cos + box.halfH * sin + box.shift
    for (const axis of ['x', 'y'] as const) {
      const lead = axis === 'x' ? cos : sin
      // Вертикальная надпись по X (и горизонтальная по Y) кадр не растягивает.
      if (lead < 1e-9) continue
      const edge = axis === 'x' ? box.halfW : box.halfH
      const span = axis === 'x' ? wPx : hPx
      scale = Math.min(scale, (span / 2 - edge - pull * lead) / (radius * lead))
    }
  }
  scale = Math.max(scale, 0.05)
  const width = round2(wPx / scale)
  const height = round2(hPx / scale)
  return {
    viewBox: `${round2(100 - width / 2)} ${round2(100 - height / 2)} ${width} ${height}`,
    pxPerUnit: scale,
  }
}