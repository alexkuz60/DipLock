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
  type DisplayThresholds,
  dipoleLayerFromScan,
  dipoleLayerStatus,
  emptyDipoleLayer,
  hiddenByThreshold,
  thresholdDipoleLayer,
  thresholdsLabel,
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
  GOF_THRESHOLD_RANGE,
  GRID_MM_RANGE,
  REFINE_HALFWIN_OPTIONS,
  THRESHOLD_NAM_RANGE,
  calcJobSummary,
  refineCostHint,
  refineHalfwinLabel,
  resultMatchesParams,
} from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { epochRuleWarnings, type EpochSignalInfo } from '@/shared/lib/epochRules'
import { BatchPanel } from './BatchPanel'
import {
  NOTCH_OPTIONS,
  notchFromOption,
  notchOptionValue,
} from '@/shared/lib/calcFilter'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { NumberField } from '@/shared/ui/NumberField'
import { Panel } from '@/shared/ui/Panel'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { SelectField } from '@/shared/ui/SelectField'
import { SliceScrubber } from '@/shared/ui/SliceScrubber'
import { StatusPill } from '@/shared/ui/StatusPill'
import { WarnList } from '@/shared/ui/WarnList'

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
  const batchJob = useDipoleCalc((state) => state.batchJob)
  const calcResult = useDipoleCalc((state) => state.result)
  const spectrum = useDipoleCalc((state) => state.spectrum)
  const gofThresholdPercent = useDipoleCalc((state) => state.gofThresholdPercent)
  const threshold = useDipoleCalc((state) => state.amplitudeThresholdNam)
  const setEpochLengthMs = useDipoleCalc((state) => state.setEpochLengthMs)
  const setGridMm = useDipoleCalc((state) => state.setGridMm)
  const setPsdMethod = useDipoleCalc((state) => state.setPsdMethod)
  const setGofThreshold = useDipoleCalc((state) => state.setGofThreshold)
  const setAmplitudeThreshold = useDipoleCalc((state) => state.setAmplitudeThreshold)
  const setNotchHz = useDipoleCalc((state) => state.setNotchHz)
  const refineHalfwinMs = useDipoleCalc((state) => state.refineHalfwinMs)
  const setRefineHalfwinMs = useDipoleCalc((state) => state.setRefineHalfwinMs)
  const resetCalc = useDipoleCalc((state) => state.reset)
  // Паспорт записи — sfreq и каналы для правила N ≥ 3C (п.4): без загруженной
  // записи и в демо эта половина правила молчит, период-правило работает по полосе
  const recording = useEdfRecording((state) => state.recording)
  const demo = useEdfRecording((state) => state.demo)
  const signal: EpochSignalInfo =
    recording && !demo
      ? { sfreq: recording.sfreq, nChannels: recording.channels?.length || recording.n_channels }
      : {}

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

  // Диапазоны ритмов — тот же `/meta`, из которого берутся длины эпох
  const freqBands = meta.data?.freq_bands ?? {}
  const functionalBands = meta.data?.functional_bands ?? {}
  /**
   * Нижняя граница самой низкой полосы каталога: правило «≥ 2 периодов» для
   * пакета читается по его медленной полосе (пакет всегда считает весь каталог,
   * «Фильтр расчёта» убран). `null` — каталог ещё не пришёл, правило молчит.
   */
  const packageLoHz = (() => {
    const lows = [...Object.values(freqBands), ...Object.values(functionalBands)]
      .map((range) => range[0])
      .filter((value) => Number.isFinite(value) && value > 0)
    return lows.length > 0 ? Math.min(...lows) : null
  })()
  // Результат посчитан на других параметрах: панель обязана сказать это явно,
  // а не выглядеть «актуальной» (та же подпись, что в таблице локализации)
  const staleResult = calcResult !== null && !resultMatchesParams(calcResult, calcParams)

  const layer = calcResult ? dipoleLayerFromScan(calcResult) : EMPTY_DIPOLE_LAYER
  /** Пороги отображения (GOF % — основной, момент нА·м — дополнительный) */
  const thresholds: DisplayThresholds = { minGofPercent: gofThresholdPercent, minAmplitudeNaM: threshold }
  const visibleLayer = thresholdDipoleLayer(layer, thresholds)
  const hidden = hiddenByThreshold(layer, thresholds)

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
              batchJob?.status === 'failed'
                ? 'danger'
                : batchJob?.status === 'running'
                  ? 'accent'
                  : calcResult
                    ? 'ok'
                    : 'neutral'
            }
          >
            {calcJobSummary(batchJob)}
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
            {spectrum ? `Спектр: диапазонов ${spectrum.bands?.length ?? 0}` : 'Спектр не рассчитан'}
          </StatusPill>
        </div>

        <SelectField
          label="Сетевой фильтр"
          value={notchOptionValue(calcParams.notchHz)}
          options={NOTCH_OPTIONS}
          onChange={(value) => setNotchHz(notchFromOption(value))}
          hint="50/60 Гц: подавляет наводку сети. Уходит в задачу как notch_hz."
        />
        <p className="mt-2 text-sm text-fg-2">
          Пакет диполей считается по всем полосам каталога (δ…high-γ и функциональные
          ритмы из /meta): свою полосу фильтра выбирают полосы пакета, а не форма.
        </p>

        <SelectField
          label="Длина эпохи"
          value={String(calcParams.epochLengthMs)}
          options={epochOptions}
          disabled={epochLengths.length === 0}
          onChange={(value) => setEpochLengthMs(Number(value))}
          hint="Длины эпох задаёт сервер (список нарезки): правка помечает расчёт устаревшим, но ничего не запускает."
        />
        {/* Две половины правила читаются вместе: ≥ 2 периодов медленной полосы
            пакета (достоверность пика) и ≥ 3C отсчётов (обратимость ковариации) —
            предупреждением, не запретом */}
        <WarnList
          testId="epoch-rule-warnings"
          items={epochRuleWarnings({
            lengthMs: calcParams.epochLengthMs,
            bandLoHz: packageLoHz,
            ...signal,
          })}
        />
        <SegmentedControl
          label="Метод PSD"
          value={calcParams.psdMethod}
          options={[
            {
              value: 'welch',
              label: 'Welch',
              title: 'Привычная оценка окном n_fft: хороша для эпох длиннее секунды',
            },
            {
              value: 'multitaper',
              label: 'Multitaper',
              title: 'DPSS на всей эпохе: для коротких эпох (250–500 мс) даёт честное разрешение',
            },
          ]}
          onChange={setPsdMethod}
          hint="Спектр: Welch для длинных эпох, multitaper — для коротких (N17). Уходит в задачу спектра, на диполи не влияет; правка ничего не запускает."
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
        {/*
          Окно уточнения (шаг 1.5): свободный фитинг «Уточнить…» идёт по окну вокруг
          пика GFP, и каждый отсчёт стоит ≈7 с. Здесь выбирается окно, а время
          оценивается по числам `/meta` — то есть по замеру, а не по надежде.
        */}
        <SelectField
          label="Окно уточнения"
          value={String(refineHalfwinMs)}
          options={REFINE_HALFWIN_OPTIONS.map((value) => ({
            value: String(value),
            label: refineHalfwinLabel(value),
          }))}
          onChange={(value) => setRefineHalfwinMs(Number(value))}
          hint={
            'Свободный фитинг кнопки «Уточнить…» вокруг пика GFP: ' +
            refineCostHint(meta.data, calcResult?.sfreq ?? null, refineHalfwinMs)
          }
        />
        <NumberField
          label="GOF ≥"
          value={gofThresholdPercent}
          min={GOF_THRESHOLD_RANGE[0]}
          max={GOF_THRESHOLD_RANGE[1]}
          step={1}
          unit="%"
          onChange={setGofThreshold}
          hint="Основной порог отображения: диполи с GOF ниже не рисуются на проекциях, но остаются в результате задачи. 0 — без фильтра."
        />
        <NumberField
          label="Момент диполя ≥"
          value={threshold}
          min={THRESHOLD_NAM_RANGE[0]}
          max={THRESHOLD_NAM_RANGE[1]}
          step={5}
          unit="нАм"
          onChange={setAmplitudeThreshold}
          hint="Дополнительная фильтрация по моменту (не «КД»): диполи слабее момента не рисуются на проекциях, но остаются в результате задачи. 0 — без фильтра."
        />
        {hidden > 0 ? (
          <p className="mt-1 text-sm text-warn">
            {`Скрыто порогами «${thresholdsLabel(thresholds)}»: ${hidden} из ${layer.points.length}`}
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
          Расчёт пакета запускается кнопкой «Рассчитать пакет» в шапке раздела, спектр —
          кнопкой в панели «Топокарты ритмов»: правка параметров здесь ничего не запускает.
        </p>
        <p className="mt-2 text-sm text-fg-2">{dipoleLayerStatus(visibleLayer)}</p>
        {calcResult?.warnings?.length ? (
          <ul className="mt-1 list-inside list-disc text-sm text-warn">
            {calcResult.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </Panel>
      {/* С1/С2: набор поддиапазонов одним прогоном — сопоставление и кластеры */}
      <BatchPanel />
    </>
  )
}
