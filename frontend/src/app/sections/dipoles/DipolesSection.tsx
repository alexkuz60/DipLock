/**
 * Рабочая область раздела «Диполи» (срез 3.1, срез МРТ — 3.2, расчёт — 3.4).
 *
 * Раздел показывает **геометрию и результат**: реальный срез T1 (картинка с
 * сервера), силуэт головы, схему среза MNI, поля Бродмана и точки диполей из
 * результата задачи (быстрый режим, `shared/lib/dipolePoints.ts`). Расчёт идёт
 * **только по кнопке в шапке** (`POST /recordings/{id}/dipole_batch`, все полосы
 * каталога), правка параметров панели ничего не запускает — она лишь
 * скрывает/показывает уже посчитанные точки (пороги отображения: GOF % и момент
 * нА·м) и наводит срезы.
 *
 * Запросы раздела: `/meta` за ссылками на статику (срезы МРТ и контуры атласа) и —
 * по кнопке — задачи расчёта. Пороги отображения («GOF ≥ X %» — основной,
 * «Момент диполя ≥ X нАм» — дополнительный) — параметры отображения: они
 * фильтруют слой перед отрисовкой, поэтому счётчик скрытых точек считается по
 * слою, а не по результату задачи (в результате точки остаются). Настоящий «КД»
 * (критерий годности, `kd_passed`) — вердикт анализа С0, в отображении не участвует.
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
 * референс-точка) и `shared/state/dipoleCalc.ts` (параметры расчёта, пороги
 * отображения, результаты задач). Клик по любой проекции наводит все три среза на выбранную
 * точку (`applyPointToSlices`).
 *
 * **Пояснений в рабочей области нет** (поправка ручной проверки): абзац о том, как
 * читать фигуры, переехал в диалог «Справка» (`DipolesHelpDialog`, кнопка в
 * тулс-хедере). Числа живут в элементах тулс-хедера и панели «Опции» — рабочая
 * область показывает только данные (геометрию и результат), объяснения читаются
 * по запросу и не съедают экран. Готовность/BAD/выбор эпох — второй ряд шапки
 * (`EpochDipoleStrip`): клик по ячейке показывает пакет диполей своей эпохи.
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
} from '@/shared/lib/mriProjections'
import {
  contourSliceUrl,
} from '@/shared/lib/atlasContours'
import { mriMipOutlineUrl } from '@/shared/lib/mriSlices'
import { batchDipoleLayer } from '@/shared/lib/dipoleBatch'
import {
  type DisplayThresholds,
  dipoleLayerFromScan,
  dipolePointTitle,
  emptyDipoleLayer,
  withOverlapCounts,
  thresholdDipoleLayer,
} from '@/shared/lib/dipolePoints'
import { api } from '@/shared/api/client'
import { useDipoleParams } from '@/shared/state/dipoleParams'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { Button } from '@/shared/ui/Button'
import { StatusPill } from '@/shared/ui/StatusPill'
import { Brain3D } from './Brain3D'
import { EloretaCard } from './EloretaCard'
import { MriProjection } from './MriProjection'
import { PlaybackAnatomyLine } from './PlaybackAnatomyLine'
import { PlaybackFrameProvider } from './PlaybackFrame'

/**
 * Пустой слой диполей — общий объект на все рендеры: раздел не имитирует расчёт,
 * а постоянная ссылка не сбрасывает мемоизацию маркеров каждый рендер.
 */
const EMPTY_DIPOLE_LAYER = emptyDipoleLayer()

export function DipolesSection() {
  const slices = useDipoleParams((state) => state.params.slices)
  const visibility = useDipoleParams((state) => state.params.layerVisibility)
  const view3d = useDipoleParams((state) => state.params.view3d)
  const selection = useDipoleParams((state) => state.selection)
  const selectPoint = useDipoleParams((state) => state.selectPoint)
  const projectionCursor = useDipoleParams((state) => state.projectionCursor)
  const setProjectionCursor = useDipoleParams((state) => state.setProjectionCursor)

  const result = useDipoleCalc((state) => state.result)
  const batch = useDipoleCalc((state) => state.batch)
  const playbackBandKeys = useDipoleCalc((state) => state.playbackBandKeys)
  const minGofPercent = useDipoleCalc((state) => state.gofThresholdPercent)
  const minAmplitudeNaM = useDipoleCalc((state) => state.amplitudeThresholdNam)
  const selectedPointId = useDipoleCalc((state) => state.selectedPointId)
  const toggleSelectedPoint = useDipoleCalc((state) => state.toggleSelectedPoint)
  const clearSelectedPoint = useDipoleCalc((state) => state.clearSelectedPoint)
  const eloretaResults = useDipoleCalc((state) => state.eloretaResults)
  const eloretaError = useDipoleCalc((state) => state.eloretaError)
  /** Карточки eLORETA по возрастанию номера эпохи (детерминированный порядок). */
  const eloretaCards = useMemo(
    () =>
      Object.entries(eloretaResults)
        .map(([epochIndex, value]) => [Number(epochIndex), value] as const)
        .sort(([left], [right]) => left - right),
    [eloretaResults],
  )
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
  /** Ссылка на тома для 3D-вида (срез 3.5): `null` — вид показывает причину. */
  const volumesRef = meta.data?.mri_volumes ?? null

  /**
   * Контуры атласа по срезу каждой плоскости (срез 3.9). Это **статические
   * ассеты**, а не обработка: запросы идут только когда слои структур/полей/
   * Контуры запрашиваются, когда включён хотя бы один слой, который из них
   * рисуется (анатомия, поля Бродмана); слой «Границы мозга» статичен и
   * контуров не ждёт (срез 3.12, доводка), срез квантуется к сетке атласа,
   * а версия ассета — ключ кэша браузера. Пустой ответ — «на срезе метки нет»,
   * и он не подменяется фикстурой.
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
  /** Обводка glass brain (слой «Границы мозга»): силуэт коры `*.pial` по плоскостям. */
  const mipOutlineQuery = useQuery({
    queryKey: ['mip-outline', mri?.version ?? 'none'],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api.mipOutline(mriMipOutlineUrl(mri as NonNullable<typeof mri>), signal),
    enabled: visibility.brain && mri !== null,
    staleTime: 300_000,
    retry: false,
  })
  /**
   * Слой диполей из результата задачи. У пакета (С1) облако — точки **всех
   * отмеченных полос** (`playbackBandKeys`) в полосных цветах (п.1.4 17.10.2026);
   * одиночный расчёт — прежний слой своего результата. Результат не
   * пересчитывается на клиенте: смена порогов отображения меняет только
   * **отрисовку** (какие точки рисовать), поэтому слой строится из результата и
   * фильтруется порогами отдельной чистой функцией. Пороги (GOF % — основной,
   * момент нА·м — дополнительный) — параметры отображения, а «КД» (вердикт
   * `kd_passed`) — параметр анализа (С0).
   */
  const layer = useMemo(() => {
    if (batch) return batchDipoleLayer(batch, playbackBandKeys)
    return result ? dipoleLayerFromScan(result) : EMPTY_DIPOLE_LAYER
  }, [batch, playbackBandKeys, result])
  /** Пороги отображения — мемоизированный объект: от него зависит перерисовка */
  const thresholds: DisplayThresholds = useMemo(
    () => ({ minGofPercent, minAmplitudeNaM }),
    [minGofPercent, minAmplitudeNaM],
  )
  const visibleLayer = useMemo(() => thresholdDipoleLayer(layer, thresholds), [layer, thresholds])
  /**
   * Слой для проекций: каждой точке проставляется кратность узла сетки
   * (`overlapCount`) — по ней рисуется размер кольца и заливка (поправка ручной
   * проверки, 18.09.2026). Считается по **видимому** слою, то есть после порогов
   * отображения: кольцо не должно обещать диполи, которые скрыты порогом. Координаты,
   * векторы и анимация от этого не меняются — это производное число для отрисовки.
   */
  const displayLayer = useMemo(() => withOverlapCounts(visibleLayer), [visibleLayer])
  /**
   * Выбранная эпоха индикатора эпох (3.3, `EpochDipoleStrip`): проекции и 3D
   * показывают **пакет диполей** этой эпохи — точки всех отображаемых полос
   * одним слоем. Выбор — состояние просмотра (расчёт не запускает и не
   * устаревает), снимается повторным кликом по ячейке.
   */
  const selectedEpochIndex = useDipoleCalc((state) => state.selectedEpochIndex)
  const epochLayer = useMemo(
    () =>
      selectedEpochIndex === null
        ? displayLayer
        : {
            ...displayLayer,
            points: displayLayer.points.filter(
              (point) => point.epochIndex === selectedEpochIndex,
            ),
          },
    [displayLayer, selectedEpochIndex],
  )
  /**
   * Выделенный диполь ищем в **полном** слое, а не в отфильтрованном порогами:
   * пороги отображения управляют только отрисовкой, и уже выделенная точка не должна
   * «теряться» из подписи при подъёме порога.
   */
  const selected = selectedPointId
    ? (layer.points.find((point) => point.id === selectedPointId) ?? null)
    : null
  /**
   * Кратность узла для подписи выделенного диполя берётся из слоя отрисовки (с
   * учётом порога): если диполь скрыт порогом, числа диполей в узле не показываем —
   * «1» было бы выдумкой, а «3» не совпало бы с картинкой.
   */
  const selectedOverlap = selected
    ? displayLayer.points.find((point) => point.id === selected.id)?.overlapCount
    : undefined
  const selectedTitle = selected
    ? dipolePointTitle(
        selectedOverlap === undefined ? selected : { ...selected, overlapCount: selectedOverlap },
      )
    : ''

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      {/*
        Выделенный диполь: клик по точке в любой проекции выделяет его во всех
        трёх. Строка нужна, чтобы у выбора была читаемая подпись (а не только
        подсветка на фигуре) и чтобы выделение можно было снять, не попав мышью
        в ту же точку.
      */}
      {selected ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone="accent" title={selectedTitle}>
            {`Выделен диполь: ${selectedTitle}`}
          </StatusPill>
          <Button onClick={clearSelectedPoint} title="Снять выделение со всех проекций">
            Снять выделение
          </Button>
        </div>
      ) : null}

      {/* Анатомия кадра воспроизведения (срез 3.7): структура и поле кадра плюс
          ближайшая смена. Строка подписана на номер эпохи из состояния, а не на
          контекст кадра, поэтому облако при движении кадра не перерисовывается. */}
      <PlaybackAnatomyLine />

      {/* eLORETA (остаток B9): карточки посчитанных эпох — пик и ROI-доли.
          Порядок — по номеру эпохи; ошибки отдельной строкой (не карточкой). */}
      {eloretaError ? (
        <p className="text-sm text-warn" data-testid="eloreta-error">
          {`eLORETA не посчитано: ${eloretaError}`}
        </p>
      ) : null}
      {eloretaCards.length > 0 ? (
        <div className="space-y-2">
          {eloretaCards.map(([epochIndex, eloreta]) => (
            <EloretaCard key={epochIndex} epochIndex={epochIndex} result={eloreta} />
          ))}
        </div>
      ) : null}

      {/*
        Колонки пропорциональны ширине фигур (`projectionBox`), а не равны: фигуры
        прямоугольные, и при равных колонках одна и та же анатомия вышла бы в разных
        масштабах — пропала бы та самая общая шкала мм/пиксель. Так коэффициент
        растяжения SVG (`колонка / ширина фигуры`) у всех трёх одинаков.

        3D-вид (срез 3.5) — альтернатива проекциям, а не слой над ними: он
        занимает ту же рабочую область, параметр `view3d` — отрисовка (расчёт не
        запускает и не устаревает).
      */}
      {view3d ? (
        <Brain3D
          volumes={volumesRef}
          layer={epochLayer}
          cursor={projectionCursor}
          onCursor={setProjectionCursor}
        />
      ) : (
        <PlaybackFrameProvider>
          <div className="flex min-h-0 flex-wrap items-start gap-4">
            {PROJECTION_PLANES.map((plane, index) => (
              <MriProjection
                key={plane}
                plane={plane}
                slices={slices}
                visibility={visibility}
                points={epochLayer}
                gridMm={result?.grid_mm ?? 0}
                dimmed={playbackActive}
                selectedArea={selection.area}
                selectedStructure={selection.structure}
                contours={contourQueries[index]?.data ?? null}
                mipOutline={mipOutlineQuery.data ?? null}
                selectedPointId={selectedPointId}
                onSelectPoint={(id) => (id ? toggleSelectedPoint(id) : clearSelectedPoint())}
                reference={selection.point}
                cursor={projectionCursor}
                onCursorChange={setProjectionCursor}
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
      )}
    </div>
  )
}
