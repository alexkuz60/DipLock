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
 * Запросы раздела: `/meta` за ссылками на статику (срезы МРТ и контуры атласа) и —
 * по кнопке — задачи расчёта. Порог «КД ≥ X нАм» — параметр отображения: он
 * фильтрует слой перед отрисовкой, поэтому счётчик скрытых точек считается по
 * слою, а не по результату задачи (в результате точки остаются).
 *
 * Контуры атласа (срез 3.9) — тоже статика: `GET /surface/contours/{plane}/{mm}`
 * по срезу каждой плоскости, только когда слои «Анатомические структуры» или
 * «Поля Бродмана» включены. Метки PALS живут на поверхности коры, поэтому
 * BA-разметка **производная** (ближайшая вершина коры) — метод приходит в ответе,
 * и UI это подписывает, а не выдаёт за измеренный атлас среза.
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
 *
 * **Пояснений в рабочей области нет** (поправка ручной проверки): абзац о том, как
 * читать фигуры, переехал в диалог «Справка» (`DipolesHelpDialog`, кнопка в
 * тулс-хедере). Рабочая область показывает данные — геометрию, результат и
 * полосу состояния с числами; объяснения читаются по запросу и не съедают экран.
 *
 * Воспроизведение траектории (срез 3.7) — режим **просмотра**: часы кадра
 * (`PlaybackFrame.tsx`) идут по сетке эпох результата и интерполируют позицию и
 * момент между соседними эпохами, а команды (play/pause, покадрово, скорость)
 * приходят из шапки. Раздел подписан только на **признак** кадра, а не на его
 * номер или время: иначе облако из сотен точек перерисовывалось бы десятки раз в
 * секунду.
 */
import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import {
  PROJECTION_PLANES,
  applyPointToSlices,
  projectionBox,
  slicesSummary,
} from '@/shared/lib/mriProjections'
import {
  CONTOURS_METHOD_HINT,
  contourSliceUrl,
  contourSummary,
} from '@/shared/lib/atlasContours'
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
import { PlaybackFrameProvider } from './PlaybackFrame'

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
  /**
   * Режим кадра воспроизведения (срез 3.7). Раздел подписан только на **признак**
   * кадра, а не на его номер или время: номер эпохи меняется несколько раз в
   * секунду, время — 60 раз, и подписка на них перерисовывала бы облако из сотен
   * точек. Кадр живёт в часах (`PlaybackFrameProvider`), а маркеры читают его
   * контекстом.
   *
   * Приглушение облака включается **вместе со слоем анимации** (поправка ручной
   * проверки): выключенный слой кадра — это «смотреть облако как обычно», и
   * приглушать его в этом случае незачем — кадра на фигуре нет.
   */
  const playbackActive =
    useDipoleCalc((state) => state.playback.active) && visibility.playback

  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })
  const mri = meta.data?.mri_slices ?? null
  const contoursRef = meta.data?.contours ?? null

  /**
   * Контуры атласа по срезу каждой плоскости (срез 3.9). Это **статические
   * ассеты**, а не обработка: запросы идут только когда слои структур/полей
   * включены, срез квантуется к сетке атласа, а версия ассета — ключ кэша
   * браузера. Пустой ответ — «на срезе метки нет», и он не подменяется фикстурой.
   */
  const contoursEnabled =
    contoursRef !== null && (visibility.anatomy || visibility.brodmann)
  const contourQueries = useQueries({
    queries: PROJECTION_PLANES.map((plane) => ({
      queryKey: ['contours', plane, slices[plane], contoursRef?.version ?? 'none'],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.contourSlice(contourSliceUrl(contoursRef as NonNullable<typeof contoursRef>, plane, slices[plane]), signal),
      enabled: contoursEnabled,
      staleTime: 300_000,
      retry: false,
    })),
  })
  const contoursMissing = contoursEnabled && contourQueries.some((query) => query.isError)
  const contoursLoading = contoursEnabled && contourQueries.some((query) => query.isLoading)
  const contoursCount = contourQueries.reduce(
    (total, query) => {
      const summary = contourSummary(query.data ?? null)
      return { structures: total.structures + summary.structures, areas: total.areas + summary.areas }
    },
    { structures: 0, areas: 0 },
  )
  /**
   * Подпись структуры под выбранной точкой: хранится её **id** (метка состояния —
   * машиночитаемая), а показывается человеческое имя из того среза, где структура
   * нашлась. Если срезы уехали и структуры на них нет — честно показываем id.
   */
  const selectedStructureLabel = selection.structure
    ? ((contourQueries
        .flatMap((query) => query.data?.structures ?? [])
        .find((shape) => shape.id === selection.structure)?.label) ?? selection.structure)
    : null

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
        {selectedStructureLabel ? (
          <StatusPill tone="accent" title="Структура атласа aparc+aseg под выбранной точкой">
            {`Структура под точкой: ${selectedStructureLabel}`}
          </StatusPill>
        ) : null}
        {/*
          Контуры атласа — статический ассет: подпись говорит, сколько меток пришло
          на текущие срезы, и честно молчит о производности BA-разметки (подсказка).
        */}
        <StatusPill
          tone={contoursMissing || contoursRef === null ? 'warn' : contoursLoading ? 'neutral' : 'ok'}
          title={CONTOURS_METHOD_HINT}
        >
          {contoursRef === null
            ? 'Контуры атласа: метаданные недоступны'
            : contoursMissing
              ? 'Контуры атласа недоступны'
              : contoursLoading
                ? 'Контуры атласа: запрашиваю срезы…'
                : `Атлас: структур ${contoursCount.structures}, полей ${contoursCount.areas}`}
        </StatusPill>
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
      <PlaybackFrameProvider>
        <div className="flex min-h-0 flex-wrap items-start gap-4">
          {PROJECTION_PLANES.map((plane, index) => (
            <MriProjection
              key={plane}
              plane={plane}
              slices={slices}
              visibility={visibility}
              points={visibleLayer}
              dimmed={playbackActive}
              selectedArea={selection.area}
              selectedStructure={selection.structure}
              contours={contourQueries[index]?.data ?? null}
              selectedPointId={selectedPointId}
              onSelectPoint={(id) => (id ? toggleSelectedPoint(id) : clearSelectedPoint())}
              reference={selection.point}
              mri={mri}
              className="min-w-[240px]"
              style={{ flex: `${projectionBox(plane).width} 1 0%` }}
              onPick={(point, area, structure) =>
                selectPoint(point, area, applyPointToSlices(point).orientations, structure)
              }
            />
          ))}
        </div>
      </PlaybackFrameProvider>
    </div>
  )
}
