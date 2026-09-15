/**
 * Точки диполей и векторы их моментов в проекциях мозга (срез 3.1, пустой слой).
 *
 * Слой пока **пустой по замыслу**: UI фазы 3 не считает диполи сам, а расчёт
 * (`docs/ui.md` §12, находки F17–F19) — следующий срез вместе с кнопкой запуска.
 * Поэтому панель показывает «диполей: 0» и честную подсказку «расчёт не
 * подключён», а не имитацию результата: тип точки и её связь с MNI уже описаны,
 * чтобы подключение расчёта было сменой источника данных, а не переписыванием
 * отрисовки.
 *
 * Модуль чистый (без DOM и zustand): точки рисует `sections/dipoles/MriProjection.tsx`,
 * оверлей векторов — там же, DOM-слоем поверх canvas.
 */
import {
  PLANE_AXES,
  PLANE_HORIZONTAL_SIGN,
  PLANE_VERTICAL_SIGN,
  PROJECTION_PADDING,
  projectPoint,
  type MniPoint2,
  type MniVector,
  type PixelPoint,
  type ProjectionPlane,
} from './mriProjections'
import { mulberry32 } from './demoSignal'
import type { DipoleScanResult } from '@/shared/api/types'

/** Лучший диполь эпохи: позиция в MNI, момент (вектор) и метрики качества. */
export type DipolePoint = {
  /** Ключ React: `эпоха-точка` (в контракте API — `epoch_index` + `time_ms`) */
  id: string
  epochIndex: number
  timeMs: number
  /** Позиция в MNI после `head_to_mni`, мм */
  position: MniVector
  /**
   * Ориентация диполя — три компоненты момента (А·м), задаёт направление
   * вектора на проекциях: рисуется от позиции точки, длина — по амплитуде.
   */
  orientation: MniVector
  /** Амплитуда момента, нА·м (в UI — нАм, как в таблице локализации) */
  amplitudeNaM: number
  /** Goodness of fit диполя, 0…1 */
  gof: number
  /** Поле Бродмана лучшей точки (`null` — не определено) */
  brodmannArea: string | null
}

/** Слой диполей: точки + флаг источника («результат задачи» или фикстура). */
export type DipoleLayer = {
  points: DipolePoint[]
  source: 'demo' | 'result'
}

/**
 * Пустой слой — состояние до расчёта: `source: 'result'` (данных нет, а не
 * фикстура разработки), `points: []`. Единая точка правды для панели и её счётчиков.
 */
export function emptyDipoleLayer(): DipoleLayer {
  return { points: [], source: 'result' }
}

/** Текст о состоянии слоя: панель не должна выглядеть «сломанной» без расчёта. */
export function dipoleLayerStatus(layer: DipoleLayer): string {
  if (layer.points.length === 0) return 'Расчёт диполей не подключён — слой пуст'
  return `Точек диполей: ${layer.points.length}`
}

/**
 * Слой диполей из результата быстрого расчёта (срез 3.4).
 *
 * Точки без MNI (`mni_coords === null`, fsaverage недоступен) в слой **не
 * попадают**: проекции рисуют MNI-координаты, и «нарисовать» точку в системе
 * головы значило бы показать её не там. Такие точки сообщаются предупреждением
 * задачи, а не подменой координат.
 */
export function dipoleLayerFromScan(result: DipoleScanResult): DipoleLayer {
  const points: DipolePoint[] = []
  for (const point of result.points) {
    const coords = point.mni_coords
    if (!coords || coords.length !== 3) continue
    const [x, y, z] = coords
    if (![x, y, z].every(Number.isFinite)) continue
    points.push({
      id: `${point.epoch_index}-${Math.round(point.time_ms)}`,
      epochIndex: point.epoch_index,
      timeMs: point.time_ms,
      position: { x, y, z },
      orientation: {
        x: point.moment[0] ?? 0,
        y: point.moment[1] ?? 0,
        z: point.moment[2] ?? 0,
      },
      amplitudeNaM: point.amplitude_nam,
      gof: point.gof,
      brodmannArea: point.brodmann_area,
    })
  }
  return { points, source: 'result' }
}

/**
 * Слой с порогом по моменту «КД ≥ X нАм»: слабые диполи скрываются.
 *
 * Порог — параметр **отображения**: он не меняет результат задачи (точки в слое
 * остаются теми же), поэтому счётчик скрытых точек возвращается отдельно, и
 * панель объясняет, что часть диполей не рисуется из-за порога.
 */
export function thresholdDipoleLayer(layer: DipoleLayer, minAmplitudeNaM: number): DipoleLayer {
  if (!(minAmplitudeNaM > 0)) return layer
  return { points: layer.points.filter((point) => point.amplitudeNaM >= minAmplitudeNaM), source: layer.source }
}

/** Сколько точек скрыто порогом (для пояснения в панели). */
export function hiddenByThreshold(layer: DipoleLayer, minAmplitudeNaM: number): number {
  if (!(minAmplitudeNaM > 0)) return 0
  return layer.points.filter((point) => point.amplitudeNaM < minAmplitudeNaM).length
}

/** Масштаб вектора на проекции: пикселей на 1 нА·м момента. */
export const VECTOR_PX_PER_NA_M = 0.5

/** Вектор не короче этого (иначе точка без «луча» выглядит как артефакт отрисовки). */
export const VECTOR_MIN_PX = 7

/** Верхняя граница длины вектора: сильный диполь не должен закрывать всю проекцию. */
export const VECTOR_MAX_PX = 30

/** Длина вектора диполя в пикселях по амплитуде момента (с зажимом в разумные рамки). */
export function dipoleVectorLength(amplitudeNaM: number): number {
  const raw = Math.abs(amplitudeNaM) * VECTOR_PX_PER_NA_M
  return Math.min(VECTOR_MAX_PX, Math.max(VECTOR_MIN_PX, raw))
}

/**
 * Проекция вектора момента на плоскость проекции: направление в нормализованных
 * осях фигуры (u — горизонталь, v — вертикаль).
 *
 * Берутся только две компоненты момента, лежащие в плоскости среза; компонента
 * вдоль нормали среза направление луча не меняет — поэтому на проекции видны
 * именно две её оси, а не «сплющенный» 3D-вектор.
 */
export function dipoleVectorDirection(plane: ProjectionPlane, orientation: MniVector): MniPoint2 {
  const [horizontal, vertical] = PLANE_AXES[plane]
  const u = PLANE_HORIZONTAL_SIGN[plane] * orientation[horizontal]
  const v = PLANE_VERTICAL_SIGN[plane] * orientation[vertical]
  const norm = Math.hypot(u, v)
  if (norm < 1e-9) return { u: 0, v: 0 }
  return { u: u / norm, v: v / norm }
}

/** Маркер диполя на проекции: точка в пикселях, конец вектора и длина луча. */
export type DipoleMarker = {
  /** Позиция диполя на фигуре, px */
  at: PixelPoint
  /** Конец вектора направления, px (`null` — момент лежит вдоль нормали среза) */
  end: PixelPoint | null
  /** Длина луча, px */
  vectorPx: number
}

/**
 * Маркер диполя на плоскости: позиция точки плюс вектор направления момента.
 *
 * `null` в `end` — момент направлен перпендикулярно срезу: на этой проекции
 * диполь видно «в торец», и стрелка была бы нулевой длины и читалась бы как
 * ошибка. Компонент рисует такую точку кольцом без луча.
 */
export function dipoleMarker(
  plane: ProjectionPlane,
  point: DipolePoint,
  padding = PROJECTION_PADDING,
): DipoleMarker {
  const at = projectPoint(plane, point.position, padding)
  const direction = dipoleVectorDirection(plane, point.orientation)
  const vectorPx = dipoleVectorLength(point.amplitudeNaM)
  if (direction.u === 0 && direction.v === 0) return { at, end: null, vectorPx: 0 }
  return {
    at,
    end: {
      x: at.x + direction.u * vectorPx,
      // Экранная вертикаль инвертирована: +v направлен вверх, а y растёт вниз
      y: at.y - direction.v * vectorPx,
    },
    vectorPx,
  }
}

/** Подпись точки для тултипа: эпоха, время, координаты, амплитуда и GOF. */
export function dipolePointTitle(point: DipolePoint): string {
  const [x, y, z] = [point.position.x, point.position.y, point.position.z]
  const area = point.brodmannArea ? `, ${point.brodmannArea}` : ''
  return `Эпоха ${point.epochIndex + 1}, ${(point.timeMs / 1000).toFixed(3)} с: MNI ${x.toFixed(1)} / ${y.toFixed(1)} / ${z.toFixed(1)}${area}, ${point.amplitudeNaM.toFixed(1)} нАм, GOF ${(point.gof * 100).toFixed(1)} %`
}

/**
 * Фикстура слоя диполей — **только для проверки отрисовки** (тесты и отладка
 * компонента). В UI слой остаётся пустым (`emptyDipoleLayer`): раздел не
 * имитирует расчёт, точки появятся из результата задачи (следующий срез фазы 3).
 *
 * Точки детерминированы (mulberry32 по сиду) и лежат рядом с именованными
 * срезами, чтобы их было видно на всех трёх проекциях.
 */
export function demoDipoleLayer(seed = 42, count = 6): DipoleLayer {
  const rand = mulberry32(seed)

  const points: DipolePoint[] = []
  for (let index = 0; index < count; index++) {
    const position: MniVector = {
      x: Math.round((rand() * 60 - 30) * 10) / 10,
      y: Math.round((rand() * 70 - 45) * 10) / 10,
      z: Math.round((rand() * 60 - 10) * 10) / 10,
    }
    const amplitudeNaM = 10 + rand() * 60
    points.push({
      id: `${0}-${index}`,
      epochIndex: 0,
      timeMs: index * 20,
      position,
      orientation: { x: rand() - 0.5, y: rand() - 0.5, z: rand() - 0.5 },
      amplitudeNaM: Math.round(amplitudeNaM * 10) / 10,
      gof: Math.round((0.6 + rand() * 0.39) * 1000) / 1000,
      brodmannArea: null,
    })
  }
  return { points, source: 'demo' }
}
