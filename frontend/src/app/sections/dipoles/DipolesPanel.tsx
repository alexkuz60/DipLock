/**
 * Панель опций раздела «Диполи» (срез 3.1): видимость слоёв проекций, срезы MNI
 * и референс-точка.
 *
 * Панель только собирает выбор пользователя (zustand `dipoleParams`) и ничего не
 * запускает: расчёт диполей появится отдельной задачей по кнопке тулс-хедера
 * (правило раздела — как в EDF, см. `docs/ui.md`).
 */
import { RotateCcw } from 'lucide-react'
import {
  AXIS_LABELS,
  PLANE_AXIS,
  PROJECTION_LABELS,
  PROJECTION_PLANES,
  SLICE_ORIENTATION_PRESETS,
  coordsLabel,
  planeSliceRange,
  sliceOrientationMarks,
  sliceTicks,
} from '@/shared/lib/mriProjections'
import { dipoleLayerStatus, emptyDipoleLayer } from '@/shared/lib/dipolePoints'
import {
  DIPOLE_LAYERS,
  DIPOLE_LAYER_HINTS,
  DIPOLE_LAYER_LABELS,
  layerVisible,
  useDipoleParams,
} from '@/shared/state/dipoleParams'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { Panel } from '@/shared/ui/Panel'
import { SliceScrubber } from '@/shared/ui/SliceScrubber'
import { StatusPill } from '@/shared/ui/StatusPill'

/** Слой диполей пуст: панель объясняет это, а не выглядит «сломанной». */
const EMPTY_DIPOLE_LAYER = emptyDipoleLayer()

export function DipolesPanel() {
  const params = useDipoleParams((state) => state.params)
  const selection = useDipoleParams((state) => state.selection)
  const setLayerVisible = useDipoleParams((state) => state.setLayerVisible)
  const setSlice = useDipoleParams((state) => state.setSlice)
  const resetSlices = useDipoleParams((state) => state.resetSlices)
  const resetAll = useDipoleParams((state) => state.resetAll)

  return (
    <>
      <Panel
        title="Фоновые слои"
        hint="Слои рисуются снизу вверх: срез МРТ, силуэт головы, схема среза MNI, поля Бродмана, точки диполей. Пока срез МРТ включён, условная схема среза не рисуется."
      >
        {DIPOLE_LAYERS.map((layer) => (
          <CheckboxRow
            key={layer}
            label={DIPOLE_LAYER_LABELS[layer]}
            hint={DIPOLE_LAYER_HINTS[layer]}
            checked={layerVisible(params.layerVisibility, layer)}
            onChange={(checked) => setLayerVisible(layer, checked)}
          />
        ))}
      </Panel>

      <Panel
        title="Срезы MNI"
        hint="Линейка наводит срез точно, клик по проекции — по месту. Именованные срезы (x = 0 …) отмечены маркерами и «притягивают» клик."
      >
        {PROJECTION_PLANES.map((plane) => {
          const [minMm, maxMm] = planeSliceRange(plane)
          return (
            <div key={plane} className="ui-list-row py-2">
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-sm text-fg-1">{PROJECTION_LABELS[plane]}</span>
                <span className="text-xs text-fg-2">{AXIS_LABELS[PLANE_AXIS[plane]]}</span>
              </div>
              <SliceScrubber
                label={`Срез ${PLANE_AXIS[plane]}, ${PROJECTION_LABELS[plane].toLowerCase()}`}
                valueMm={params.slices[plane]}
                minMm={minMm}
                maxMm={maxMm}
                ticks={sliceTicks(plane)}
                marks={sliceOrientationMarks(plane).map((mark) => ({
                  valueMm: mark.valueMm,
                  label: mark.mark,
                  title: mark.label,
                }))}
                onChange={(value) => setSlice(plane, value)}
              />
            </div>
          )
        })}
      </Panel>

      <Panel
        title="Точка и поля"
        hint="Клик по проекции наводит все три среза на точку; поле Бродмана под кликом подсвечивается."
      >
        <p className="tnum font-mono text-sm text-fg-1">
          {selection.point ? coordsLabel(selection.point) : 'Точка не выбрана'}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {PROJECTION_PLANES.map((plane) => {
            const orientation = selection.orientations[plane]
            if (!orientation) return null
            return (
              <StatusPill key={plane} tone="accent">
                {`${PROJECTION_LABELS[plane]}: ${SLICE_ORIENTATION_PRESETS[orientation].label}`}
              </StatusPill>
            )
          })}
          {selection.area ? <StatusPill tone="ok">{selection.area}</StatusPill> : null}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            icon={<RotateCcw className="size-4" />}
            onClick={resetSlices}
            title="Вернуть срезы на именованные (x = 0, y = 0, z = 0) и снять точку"
          >
            К именованным срезам
          </Button>
          <Button
            icon={<RotateCcw className="size-4" />}
            onClick={resetAll}
            title="Вернуть слои и срезы к значениям по умолчанию"
          >
            Всё по умолчанию
          </Button>
        </div>
      </Panel>

      <Panel
        title="Расчёт"
        hint="Раздел пока показывает геометрию: задача расчёта диполей появится отдельной кнопкой в шапке раздела (следующий срез фазы 3)."
      >
        <StatusPill tone="neutral">{dipoleLayerStatus(EMPTY_DIPOLE_LAYER)}</StatusPill>
      </Panel>
    </>
  )
}
