/**
 * Панель опций раздела «Диполи» (срез 3.1): видимость слоёв проекций, срезы MNI
 * и референс-точка.
 *
 * Панель только собирает выбор пользователя (zustand `dipoleParams`) и ничего не
 * запускает: расчёт диполей появится отдельной задачей по кнопке тулс-хедера
 * (правило раздела — как в EDF, см. `docs/ui.md`).
 */
import { useQuery } from '@tanstack/react-query'
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
import {
  dipoleLayerFromScan,
  dipoleLayerStatus,
  emptyDipoleLayer,
  hiddenByThreshold,
  thresholdDipoleLayer,
} from '@/shared/lib/dipolePoints'
import { api } from '@/shared/api/client'
import {
  DIPOLE_LAYERS,
  DIPOLE_LAYER_HINTS,
  DIPOLE_LAYER_LABELS,
  layerVisible,
  useDipoleParams,
} from '@/shared/state/dipoleParams'
import {
  GRID_MM_RANGE,
  THRESHOLD_NAM_RANGE,
  calcJobSummary,
  resultMatchesParams,
  useDipoleCalc,
} from '@/shared/state/dipoleCalc'
import {
  BANDWIDTH_RANGE,
  BAND_RANGE,
  NOTCH_OPTIONS,
  SINGLE_FREQ_RANGE,
  WIDE_FILTER_BAND,
  filterPresetOf,
  filterPresetOptions,
  filterSummary,
  notchFromOption,
  notchOptionValue,
} from '@/shared/lib/calcFilter'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { NumberField } from '@/shared/ui/NumberField'
import { Panel } from '@/shared/ui/Panel'
import { SelectField } from '@/shared/ui/SelectField'
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

  const calcParams = useDipoleCalc((state) => state.params)
  const calcJob = useDipoleCalc((state) => state.job)
  const calcResult = useDipoleCalc((state) => state.result)
  const spectrum = useDipoleCalc((state) => state.spectrum)
  const threshold = useDipoleCalc((state) => state.amplitudeThresholdNam)
  const setEpochLengthMs = useDipoleCalc((state) => state.setEpochLengthMs)
  const setGridMm = useDipoleCalc((state) => state.setGridMm)
  const setRejectThresholdUv = useDipoleCalc((state) => state.setRejectThresholdUv)
  const setAmplitudeThreshold = useDipoleCalc((state) => state.setAmplitudeThreshold)
  const setFilterPreset = useDipoleCalc((state) => state.setFilterPreset)
  const setFilterBand = useDipoleCalc((state) => state.setFilterBand)
  const setNotchHz = useDipoleCalc((state) => state.setNotchHz)
  const setSingleFreq = useDipoleCalc((state) => state.setSingleFreq)
  const setBandwidth = useDipoleCalc((state) => state.setBandwidth)
  const resetCalc = useDipoleCalc((state) => state.reset)

  // Длины эпох приходят из `/meta` (единственный источник — конфиг сервера):
  // тот же запрос уже делает раздел EDF, поэтому кэш react-query общий
  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })
  const epochLengths = meta.data?.epoch_lengths_ms ?? []
  const epochOptions = (epochLengths.length ? epochLengths : [calcParams.epochLengthMs]).map(
    (value) => ({
      value: String(value),
      label: `${value} мс`,
    }),
  )

  // Диапазоны ритмов — тот же `/meta`, из которого берутся длины эпох: список
  // пресетов не дублирует числа конфига сервера в коде UI
  const freqBands = meta.data?.freq_bands ?? {}
  const presetOptions = filterPresetOptions(freqBands)
  // Показываем выбор пользователя; если такого пункта в текущих метаданных нет
  // (ритм убрали из конфига сервера), берём пресет по полосе — значение списка
  // не должно «повисать» вне его пунктов
  const filterPreset = presetOptions.some((option) => option.value === calcParams.filterPreset)
    ? calcParams.filterPreset
    : filterPresetOf(calcParams, freqBands)
  const filterBand = calcParams.filterBandHz ?? WIDE_FILTER_BAND
  // Результат посчитан на других параметрах: панель обязана сказать это явно,
  // а не выглядеть «актуальной» (та же подпись, что в таблице локализации)
  const staleResult = calcResult !== null && !resultMatchesParams(calcResult, calcParams)

  const layer = calcResult ? dipoleLayerFromScan(calcResult) : EMPTY_DIPOLE_LAYER
  const visibleLayer = thresholdDipoleLayer(layer, threshold)
  const hidden = hiddenByThreshold(layer, threshold)

  return (
    <>
      <Panel
        title="Фоновые слои"
        hint="Слои рисуются снизу вверх: срез МРТ, силуэт головы, схема среза MNI, поля Бродмана, точки диполей, векторы моментов. Пока срез МРТ включён, условная схема среза не рисуется. Позиции диполей и их векторы включаются раздельно: «где» и «куда» — разные вопросы, а размер и плотность маркера отражают силу момента."
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
        title="Расчёт диполей"
        hint="Быстрый режим: одна точка на эпоху в пике GFP и перебор узлов объёмной сетки на сферической модели головы (не mne.fit_dipole). Точный режим — отдельный срез; результат помечен методом, а не выдаётся за точный."
      >
        <div className="mb-2 flex flex-wrap gap-2">
          <StatusPill
            tone={
              calcJob?.status === 'failed'
                ? 'danger'
                : calcJob?.status === 'running'
                  ? 'accent'
                  : calcResult
                    ? 'ok'
                    : 'neutral'
            }
          >
            {calcJobSummary(calcJob)}
          </StatusPill>
          {calcResult ? (
            <StatusPill tone="neutral" title={`Метод: ${calcResult.method}`}>
              {`Эпох в расчёте: ${calcResult.n_epochs_used} из ${calcResult.n_epochs_total}`}
            </StatusPill>
          ) : null}
          {staleResult ? (
            <StatusPill tone="warn">
              Параметры расчёта изменены — результат не пересчитан
            </StatusPill>
          ) : null}
          <StatusPill tone={spectrum ? 'ok' : 'neutral'}>
            {spectrum ? `Спектр: диапазонов ${spectrum.bands.length}` : 'Спектр не рассчитан'}
          </StatusPill>
        </div>

        <SelectField
          label="Фильтр расчёта"
          value={filterPreset}
          options={presetOptions.map(({ value, label }) => ({ value, label }))}
          onChange={(value) => setFilterPreset(value, freqBands)}
          hint="Полоса уходит в задачу как band_min/band_max. Диапазоны ритмов приходят с сервера (/meta), одиночная частота — узкая полоса f ± bw/2. Правка ничего не запускает."
        />
        {filterPreset === 'single' ? (
          <>
            <NumberField
              label="Одиночная частота"
              value={calcParams.singleFreqHz}
              min={SINGLE_FREQ_RANGE[0]}
              max={SINGLE_FREQ_RANGE[1]}
              step={0.01}
              unit="Гц"
              onChange={setSingleFreq}
              hint="Например 7.83 Гц: полоса считается вокруг этой частоты как f ± bw/2."
            />
            <NumberField
              label="Ширина полосы"
              value={calcParams.bandwidthHz}
              min={BANDWIDTH_RANGE[0]}
              max={BANDWIDTH_RANGE[1]}
              step={0.05}
              unit="Гц"
              onChange={setBandwidth}
              hint="Ширина вокруг одиночной частоты: 0.5 Гц — как по умолчанию в предподготовке записи."
            />
          </>
        ) : null}
        {filterPreset === 'custom' ? (
          <>
            <NumberField
              label="Полоса от"
              value={filterBand[0]}
              min={BAND_RANGE[0]}
              max={BAND_RANGE[1]}
              step={0.5}
              unit="Гц"
              onChange={(value) => setFilterBand([value, filterBand[1]])}
              hint="Границы полосы: порядок полей не важен — границы встают по возрастанию."
            />
            <NumberField
              label="Полоса до"
              value={filterBand[1]}
              min={BAND_RANGE[0]}
              max={BAND_RANGE[1]}
              step={0.5}
              unit="Гц"
              onChange={(value) => setFilterBand([filterBand[0], value])}
              hint="Совпавшие границы значат «без фильтра»: полосу нулевой ширины задача не примет."
            />
          </>
        ) : null}
        <SelectField
          label="Сетевой фильтр"
          value={notchOptionValue(calcParams.notchHz)}
          options={NOTCH_OPTIONS}
          onChange={(value) => setNotchHz(notchFromOption(value))}
          hint="50/60 Гц: подавляет наводку сети. Уходит в задачу как notch_hz."
        />
        <p className="mt-2 text-sm text-fg-2">
          {`В расчёт уйдёт: ${filterSummary(calcParams, freqBands)}`}
        </p>

        <SelectField
          label="Длина эпохи"
          value={String(calcParams.epochLengthMs)}
          options={epochOptions}
          disabled={epochLengths.length === 0}
          onChange={(value) => setEpochLengthMs(Number(value))}
          hint="Длины эпох задаёт сервер (список нарезки): правка помечает расчёт устаревшим, но ничего не запускает."
        />
        <NumberField
          label="Шаг сетки"
          value={calcParams.gridMm}
          min={GRID_MM_RANGE[0]}
          max={GRID_MM_RANGE[1]}
          step={1}
          unit="мм"
          onChange={setGridMm}
          hint="Перебор узлов: мельче сетка — точнее позиция и заметно дольше расчёт."
        />
        <NumberField
          label="Порог reject"
          value={calcParams.rejectThresholdUv}
          min={0}
          max={1000}
          step={10}
          unit="мкВ"
          onChange={setRejectThresholdUv}
          hint="Эпохи выше порога в расчёт не попадают (тот же смысл, что у нарезки эпох)."
        />
        <NumberField
          label="КД ≥"
          value={threshold}
          min={THRESHOLD_NAM_RANGE[0]}
          max={THRESHOLD_NAM_RANGE[1]}
          step={5}
          unit="нАм"
          onChange={setAmplitudeThreshold}
          hint="Порог отображения: диполи слабее момента не рисуются на проекциях, но остаются в результате задачи."
        />
        {hidden > 0 ? (
          <p className="mt-1 text-sm text-warn">
            {`Скрыто порогом «КД ≥ ${threshold} нАм»: ${hidden} из ${layer.points.length}`}
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            icon={<RotateCcw className="size-4" />}
            disabled={!calcResult && !spectrum}
            onClick={resetCalc}
            title="Убрать результат расчёта и спектр (параметры и слои остаются)"
          >
            Сбросить расчёт
          </Button>
        </div>
        <p className="mt-2 text-sm text-fg-2">
          Расчёт запускается кнопкой в шапке раздела, спектр — кнопкой в панели «Топокарты ритмов»:
          правка параметров здесь ничего не запускает.
        </p>
        <p className="mt-2 text-sm text-fg-2">{dipoleLayerStatus(visibleLayer)}</p>
        {calcResult?.warnings.length ? (
          <ul className="mt-1 list-inside list-disc text-sm text-warn">
            {calcResult.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </>
  )
}
