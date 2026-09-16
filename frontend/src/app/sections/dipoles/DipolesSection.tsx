/**
 * Рабочая область раздела «Диполи» (срез 3.1, срез МРТ — 3.2, расчёт — 3.4).
 *
 * Раздел показывает **геометрию и результат**: реальный срез T1 (картинка с
 * сервера), силуэт головы, схему среза MNI, поля Бродмана и точки диполей из
 * результата задачи (быстрый режим, `shared/lib/dipolePoints.ts`). Расчёт идёт
 * **только по кнопке в шапке** (`POST /recordings/{id}/dipoles`), правка
 * параметров панели ничего не запускает — она лишь скрывает/показывает уже
 * посчитанные точки (порог «КД») и наводит срезы.
 *
 * Запросы раздела: `/meta` за ссылкой на срезы (статика) и — по кнопке — задачи
 * расчёта. Порог «КД ≥ X нАм» — параметр отображения: он фильтрует слой перед
 * отрисовкой, поэтому счётчик скрытых точек считается по слою, а не по результату
 * задачи (в результате точки остаются).
 *
 * Выделение диполя — тоже состояние **просмотра** (срез 3.5, поправка ручной
 * проверки): клик по точке в одной проекции подсвечивает её во всех трёх
 * (`selectedPointId` в `shared/state/dipoleCalc.ts`) **и** наводит срезы на её
 * позицию — срезы обязаны меняться при любом клике по фигуре.
 *
 * Состояние — в zustand-срезах `shared/state/dipoleParams.ts` (слои, срезы,
 * референс-точка) и `shared/state/dipoleCalc.ts` (параметры расчёта, порог КД,
 * результаты задач). Клик по любой проекции наводит все три среза на выбранную
 * точку (`applyPointToSlices`).
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  PROJECTION_PLANES,
  applyPointToSlices,
  projectionBox,
  slicesSummary,
} from '@/shared/lib/mriProjections'
import {
  dipoleLayerFromScan,
  dipoleLayerStatus,
  dipolePointTitle,
  emptyDipoleLayer,
  hiddenByThreshold,
  thresholdDipoleLayer,
} from '@/shared/lib/dipolePoints'
import { api } from '@/shared/api/client'
import { useDipoleParams } from '@/shared/state/dipoleParams'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { Button } from '@/shared/ui/Button'
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

  const result = useDipoleCalc((state) => state.result)
  const threshold = useDipoleCalc((state) => state.amplitudeThresholdNam)
  const selectedPointId = useDipoleCalc((state) => state.selectedPointId)
  const toggleSelectedPoint = useDipoleCalc((state) => state.toggleSelectedPoint)
  const clearSelectedPoint = useDipoleCalc((state) => state.clearSelectedPoint)

  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })
  const mri = meta.data?.mri_slices ?? null

  /**
   * Слой диполей из результата задачи. Результат не пересчитывается на клиенте:
   * смена порога «КД» меняет только **отрисовку** (какие точки рисовать), поэтому
   * слой строится из результата и фильтруется порогом отдельной чистой функцией.
   */
  const layer = useMemo(() => (result ? dipoleLayerFromScan(result) : EMPTY_DIPOLE_LAYER), [result])
  const visibleLayer = useMemo(() => thresholdDipoleLayer(layer, threshold), [layer, threshold])
  const hidden = hiddenByThreshold(layer, threshold)
  const mniMissing = result !== null && layer.points.length < result.points.length
  /**
   * Выделенный диполь ищем в **полном** слое, а не в отфильтрованном порогом:
   * порог «КД» управляет только отрисовкой, и уже выделенная точка не должна
   * «теряться» из подписи при подъёме порога.
   */
  const selected = selectedPointId
    ? (layer.points.find((point) => point.id === selectedPointId) ?? null)
    : null

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={visibleLayer.points.length ? 'ok' : 'neutral'}>
          {dipoleLayerStatus(visibleLayer)}
        </StatusPill>
        {result ? (
          <StatusPill tone="accent" title={`Метод расчёта: ${result.method}`}>
            {`Быстрый режим, сетка ${result.grid_mm} мм · эпох ${result.n_epochs_used} из ${result.n_epochs_total}`}
          </StatusPill>
        ) : null}
        {hidden > 0 ? (
          <StatusPill tone="warn">{`Скрыто порогом «КД ≥ ${threshold} нАм»: ${hidden}`}</StatusPill>
        ) : null}
        {threshold > 0 ? (
          <StatusPill tone="neutral">{`Порог КД: ≥ ${threshold} нАм`}</StatusPill>
        ) : null}
        {mniMissing ? (
          <StatusPill tone="warn">
            Часть точек без MNI (fsaverage недоступен) — на проекции не попадают
          </StatusPill>
        ) : null}
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
        Выделенный диполь: клик по точке в любой проекции выделяет его во всех
        трёх. Строка нужна, чтобы у выбора была читаемая подпись (а не только
        подсветка на фигуре) и чтобы выделение можно было снять, не попав мышью
        в ту же точку.
      */}
      {selected ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone="accent" title={dipolePointTitle(selected)}>
            {`Выделен диполь: ${dipolePointTitle(selected)}`}
          </StatusPill>
          <Button onClick={clearSelectedPoint} title="Снять выделение со всех проекций">
            Снять выделение
          </Button>
        </div>
      ) : null}

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
            points={visibleLayer}
            selectedArea={selection.area}
            selectedPointId={selectedPointId}
            onSelectPoint={(id) => (id ? toggleSelectedPoint(id) : clearSelectedPoint())}
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
        шагом сетки тома (1 мм), поэтому подпись среза может отличаться от картинки на полшага. Слои
        включаются в панели справа: позиции диполей и векторы их моментов — раздельно; позиции —
        одинаковые белые кольца фиксированного размера, а сила момента читается по длине и плотности
        луча. Клик по точке диполя <b>выделяет</b> его во всех трёх проекциях и наводит срезы на его
        позицию: повторный клик или кнопка «Снять выделение» снимают выбор. Диполи считает сервер по
        кнопке в шапке — быстрым режимом (одна точка на эпоху в пике GFP, перебор узлов сетки),
        поэтому позиция точки кратна шагу сетки, а не «миллиметр в миллиметр» как у точного фитинга;
        порог «КД ≥» скрывает слабые диполи на проекциях, не меняя результат задачи.
      </p>
    </div>
  )
}
