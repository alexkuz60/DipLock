/**
 * Рабочая область раздела «Диполи» (срез 3.1): три проекции мозга.
 *
 * Раздел показывает **геометрию**, а не результат: силуэт головы, схема среза MNI,
 * поля Бродмана и (пока пустой) слой точек диполей. Расчёт — отдельная задача по
 * кнопке (следующий срез фазы 3), поэтому здесь ничего не считается и не
 * запрашивается: правка параметров лишь меняет отрисовку.
 *
 * Состояние — в zustand-срезе `shared/state/dipoleParams.ts` (видимость слоёв,
 * срезы, референс-точка). Клик по любой проекции наводит все три среза на
 * выбранную точку (`applyPointToSlices`) — пользователь попадает в точку, которую
 * видит, а не настраивает каждый срез отдельно.
 */
import { PROJECTION_PLANES, applyPointToSlices, slicesSummary } from '@/shared/lib/mriProjections'
import { dipoleLayerStatus, emptyDipoleLayer } from '@/shared/lib/dipolePoints'
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={EMPTY_DIPOLE_LAYER.points.length ? 'ok' : 'neutral'}>
          {dipoleLayerStatus(EMPTY_DIPOLE_LAYER)}
        </StatusPill>
        <StatusPill tone="accent">Срезы: {slicesSummary(slices)}</StatusPill>
        {selection.area ? (
          <StatusPill tone="ok">Поле под точкой: {selection.area}</StatusPill>
        ) : null}
      </div>

      <div className="grid min-h-0 grid-cols-1 gap-4 xl:grid-cols-3">
        {PROJECTION_PLANES.map((plane) => (
          <MriProjection
            key={plane}
            plane={plane}
            slices={slices}
            visibility={visibility}
            points={EMPTY_DIPOLE_LAYER}
            selectedArea={selection.area}
            reference={selection.point}
            onPick={(point, area) =>
              selectPoint(point, area, applyPointToSlices(point).orientations)
            }
          />
        ))}
      </div>

      <p className="text-sm text-fg-2">
        Клик по проекции наводит все три среза на выбранную точку, а попадание в поле Бродмана
        подсвечивает его во всех проекциях. Слои включаются в панели справа; расчёт диполей
        запускается отдельной задачей и в этот срез ещё не подключён.
      </p>
    </div>
  )
}
