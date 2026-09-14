/**
 * Рабочая область раздела «Диполи» (срез 3.1, реальный срез МРТ — 3.2).
 *
 * Раздел показывает **геометрию и анатомию**, а не результат: реальный срез T1
 * (картинка с сервера), силуэт головы, схема среза MNI, поля Бродмана и (пока
 * пустой) слой точек диполей. Расчёт — отдельная задача по кнопке (следующий
 * срез фазы 3), поэтому здесь ничего не считается и не запускается: правка
 * параметров лишь меняет отрисовку.
 *
 * Запрос один и только за статикой: `/meta` отдаёт ссылку на срезы (базовый URL,
 * шаг сетки, версию ассета). Сами картинки срезов браузер грузит и кэширует по
 * URL из `<image>` — это отображение данных, а не запуск обработки.
 *
 * Состояние — в zustand-срезе `shared/state/dipoleParams.ts` (видимость слоёв,
 * срезы, референс-точка). Клик по любой проекции наводит все три среза на
 * выбранную точку (`applyPointToSlices`) — пользователь попадает в точку, которую
 * видит, а не настраивает каждый срез отдельно.
 */
import { useQuery } from '@tanstack/react-query'
import {
  PROJECTION_PLANES,
  applyPointToSlices,
  projectionBox,
  slicesSummary,
} from '@/shared/lib/mriProjections'
import { dipoleLayerStatus, emptyDipoleLayer } from '@/shared/lib/dipolePoints'
import { api } from '@/shared/api/client'
import { useDipoleParams } from '@/shared/state/dipoleParams'
import { StatusPill } from '@/shared/ui/StatusPill'
import { MriProjection } from './MriProjection'

/**
 * Пустой слой диполей — общий объект на все рендеры: раздел не имитирует расчёт,
 * а постоянная ссылка не сбрасывает мемоизацию маркеров каждый рендер.
 */
const EMPTY_DIPOLE_LAYER = emptyDipoleLayer()

export function DipolesSection() {
  const slices = useDipoleParams((state) => state.params.slices)
  const visibility = useDipoleParams((state) => state.params.layerVisibility)
  const selection = useDipoleParams((state) => state.selection)
  const selectPoint = useDipoleParams((state) => state.selectPoint)

  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })
  const mri = meta.data?.mri_slices ?? null

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={EMPTY_DIPOLE_LAYER.points.length ? 'ok' : 'neutral'}>
          {dipoleLayerStatus(EMPTY_DIPOLE_LAYER)}
        </StatusPill>
        <StatusPill tone="accent">Срезы: {slicesSummary(slices)}</StatusPill>
        <StatusPill tone={mri ? 'ok' : meta.isLoading ? 'neutral' : 'warn'}>
          {mri
            ? `МРТ: срез T1, сетка ${mri.spacing_mm} мм`
            : meta.isLoading
              ? 'МРТ: запрашиваю метаданные…'
              : 'МРТ: метаданные недоступны'}
        </StatusPill>
        {selection.area ? (
          <StatusPill tone="ok">Поле под точкой: {selection.area}</StatusPill>
        ) : null}
      </div>

      {/*
        Колонки пропорциональны ширине фигур (`projectionBox`), а не равны: фигуры
        прямоугольные, и при равных колонках одна и та же анатомия вышла бы в разных
        масштабах — пропала бы та самая общая шкала мм/пиксель. Так коэффициент
        растяжения SVG (`колонка / ширина фигуры`) у всех трёх одинаков.
      */}
      <div className="flex min-h-0 flex-wrap items-start gap-4">
        {PROJECTION_PLANES.map((plane) => (
          <MriProjection
            key={plane}
            plane={plane}
            slices={slices}
            visibility={visibility}
            points={EMPTY_DIPOLE_LAYER}
            selectedArea={selection.area}
            reference={selection.point}
            mri={mri}
            className="min-w-[240px]"
            style={{ flex: `${projectionBox(plane).width} 1 0%` }}
            onPick={(point, area) =>
              selectPoint(point, area, applyPointToSlices(point).orientations)
            }
          />
        ))}
      </div>

      <p className="text-sm text-fg-2">
        Клик по проекции наводит все три среза на выбранную точку, а попадание в поле Бродмана
        подсвечивает его во всех проекциях. Срез томографии рисуется из PNG сервера и квантуется
        шагом сетки тома (1 мм), поэтому подпись среза может отличаться от картинки на полшага.
        Слои включаются в панели справа; расчёт диполей запускается отдельной задачей и в этот срез
        ещё не подключён.
      </p>
    </div>
  )
}
