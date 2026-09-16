/**
 * Параметры раздела «Диполи» (срез 3.0): видимость фоновых слоёв проекций и
 * положение срезов MNI.
 *
 * Правило раздела то же, что в EDF (`docs/ui.md`): правка параметра **ничего не
 * запускает**. Расчёт диполей появится отдельным срезом (кнопка в тулс-хедере),
 * а пока раздел показывает только отрисовку: слои, срезы и наведение.
 *
 * Что здесь, а что нет:
 * - в сторе — то, что переживает перезаход в раздел и относится к сессии
 *   (видимость слоёв, срезы MNI, координаты последней выбранной точки, выделенное
 *   поле Бродмана, «точка под курсором» сбрасывается выходом из раздела);
 * - в локальном состоянии компонент — то, что нужно только текущей отрисовке
 *   (курсор мыши, геометрия canvas).
 *
 * В localStorage уходит только `params`: набор слоёв и срезы — это предпочтения
 * просмотра, они не зависят от записи. Референс-точка (`selection`) — состояние
 * сессии, поэтому хранится в сторе, но не персистится.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import {
  applyPointToSlices,
  clampSlice,
  defaultSlices,
  roundMm,
  sliceLabel,
  type MniSliceOrientation,
  type MniVector,
  type ProjectionPlane,
  type SliceTriplet,
} from '@/shared/lib/mriProjections'

/**
 * Фоновые слои проекций мозга: что рисуется поверх «подложки» фигуры.
 *
 * `dipoles` и `vectors` — **раздельные слои** (срез 3.5): позиции диполей и
 * векторы их моментов отвечают на разные вопросы («где» и «куда»), и выключить
 * их хочется по отдельности (например, при плотном облаке точек лучи мешают
 * читать позиции). Выключение позиций не выключает лучи: они начинаются от
 * координаты диполя, и «висеть в воздухе» без точки — нормальный вид карты
 * направлений.
 */
export type DipoleLayerId =
  | 'mri'
  | 'anatomy'
  | 'head'
  | 'mni'
  | 'brodmann'
  | 'dipoles'
  | 'vectors'

/** Порядок слоёв = порядок отрисовки снизу вверх (и порядок чекбоксов в панели). */
export const DIPOLE_LAYERS: DipoleLayerId[] = [
  'mri',
  'anatomy',
  'head',
  'mni',
  'brodmann',
  'dipoles',
  'vectors',
]

export const DIPOLE_LAYER_LABELS: Record<DipoleLayerId, string> = {
  mri: 'Срез МРТ (T1)',
  anatomy: 'Анатомические структуры',
  head: 'Силуэт головы',
  mni: 'Срезы MNI',
  brodmann: 'Поля Бродмана',
  dipoles: 'Точки диполей',
  vectors: 'Векторы моментов',
}

export const DIPOLE_LAYER_HINTS: Record<DipoleLayerId, string> = {
  mri: 'Реальный срез тома fsaverage: картинка квантуется шагом 1 мм, снаружи мозга прозрачна',
  anatomy:
    'Реальные структуры атласа aparc+aseg (кора, подкорка, желудочки): контуры приходят с сервера, метка подсвечивается и называется под курсором',
  head: 'Условная граница черепа на текущем срезе',
  mni: 'Анатомическая схема среза и линии секущих плоскостей',
  brodmann:
    'Поля Бродмана из атласа: разметка производная (метка ближайшей вершины коры), пока ассет недоступен — условные эллипсы',
  dipoles:
    'Позиции диполей из результата: одна точка на эпоху в пике GFP (порог «КД» скрывает слабые). Кольца белые, фиксированного размера; клик по точке выделяет диполь и наводит срезы на его позицию',
  vectors:
    'Направление момента диполя: луч от позиции точки, длина и толщина — по силе момента, наконечник считается от длины луча',
}

/** Слои, которые рисуются по умолчанию (точки диполей — тоже, но их пока нет). */
export const DIPOLE_PARAM_DEFAULTS = {
  layerVisibility: {
    mri: true,
    anatomy: true,
    head: true,
    mni: true,
    brodmann: true,
    dipoles: true,
    vectors: true,
  } as Record<DipoleLayerId, boolean>,
  slices: defaultSlices(),
}

export type DipoleParams = typeof DIPOLE_PARAM_DEFAULTS

/** Референс-точка сессии: последний клик по проекции и его координаты. */
export type DipoleSelection = {
  /** Точка MNI, по которой наведены срезы */
  point: MniVector | null
  /** Поле Бродмана под кликом (`null` — клик не попал в поле) */
  area: string | null
  /** Анатомическая структура атласа под кликом (`null` — не попала или нет ассета) */
  structure: string | null
  /** Ориентации, к которым «прилипли» срезы при этом клике */
  orientations: Partial<Record<ProjectionPlane, MniSliceOrientation>>
}

export const EMPTY_SELECTION: DipoleSelection = {
  point: null,
  area: null,
  structure: null,
  orientations: {},
}

export type DipoleParamsState = {
  params: DipoleParams
  /** Последний выбор пользователя в проекциях (не персистится) */
  selection: DipoleSelection
  /** Показать/скрыть фоновый слой */
  toggleLayer: (layer: DipoleLayerId) => void
  setLayerVisible: (layer: DipoleLayerId, visible: boolean) => void
  /** Навести срез одной плоскости (линейка, кнопки «−/+», точная ориентация) */
  setSlice: (plane: ProjectionPlane, valueMm: number) => void
  /** Навести срезы точкой: две координаты из клика, третья — из среза плоскости */
  selectPoint: (
    point: MniVector,
    area: string | null,
    orientations: Partial<Record<ProjectionPlane, MniSliceOrientation>>,
    structure?: string | null,
  ) => void
  /** Сбросить срезы на именованные (уровень AC–PC), точку и выделение — очистить */
  resetSlices: () => void
  /** Сбросить и слои, и срезы (кнопка «К значениям по умолчанию») */
  resetAll: () => void
}

export const useDipoleParams = create<DipoleParamsState>()(
  persist(
    (set) => ({
      params: { ...DIPOLE_PARAM_DEFAULTS, slices: defaultSlices() },
      selection: EMPTY_SELECTION,
      toggleLayer: (layer) =>
        set((state) => ({
          params: {
            ...state.params,
            layerVisibility: {
              ...state.params.layerVisibility,
              [layer]: !state.params.layerVisibility[layer],
            },
          },
        })),
      setLayerVisible: (layer, visible) =>
        set((state) => ({
          params: {
            ...state.params,
            layerVisibility: { ...state.params.layerVisibility, [layer]: visible },
          },
        })),
      setSlice: (plane, valueMm) =>
        set((state) => ({
          params: {
            ...state.params,
            slices: { ...state.params.slices, [plane]: clampSlice(plane, roundMm(valueMm)) },
          },
          // Ручное наведение среза снимает старую точку: она указывала на прежний срез
          selection: { ...state.selection, point: null, orientations: {} },
        })),
      selectPoint: (point, area, orientations, structure = null) =>
        set((state) => ({
          params: { ...state.params, slices: applyPointToSlices(point).slices },
          selection: { ...state.selection, point, area, structure, orientations },
        })),
      resetSlices: () =>
        set((state) => ({
          params: { ...state.params, slices: defaultSlices() },
          selection: EMPTY_SELECTION,
        })),
      resetAll: () =>
        set({
          params: { ...DIPOLE_PARAM_DEFAULTS, slices: defaultSlices() },
          selection: EMPTY_SELECTION,
        }),
    }),
    {
      name: 'diplock.dipoles',
      // Точка клика — состояние сессии: после перезагрузки страницы она бессмысленна.
      partialize: (state) => ({ params: state.params }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as { params?: Partial<DipoleParams> }
        const storedParams = stored.params ?? {}
        return {
          ...current,
          selection: EMPTY_SELECTION,
          params: {
            ...current.params,
            ...storedParams,
            layerVisibility: {
              ...current.params.layerVisibility,
              ...(storedParams.layerVisibility ?? {}),
            },
            slices: { ...current.params.slices, ...(storedParams.slices ?? {}) },
          },
        }
      },
    },
  ),
)

/** Подпись текущего среза плоскости для заголовка проекции. */
export function sliceTitleOf(state: DipoleParamsState, plane: ProjectionPlane): string {
  return sliceLabel(plane, state.params.slices[plane])
}

/** Включён ли фоновый слой (отсутствие ключа трактуем как «включён»). */
export function layerVisible(
  visibility: Record<DipoleLayerId, boolean>,
  layer: DipoleLayerId,
): boolean {
  return visibility[layer] !== false
}

/** Срезы раздела как тройка (для чистых функций геометрии). */
export function currentSlices(state: DipoleParamsState): SliceTriplet {
  return state.params.slices
}
