/**
 * Панель опций раздела «ЭЭГ»: канал и шкала, параметры спектрограммы, фильтр расчёта.
 *
 * Панель только правит параметры: ни один контрол не делает запросов и не
 * запускает расчёт (правило `docs/ui.md`, старт — кнопкой в шапке). Расхождение
 * с результатом показывается подписью «параметры расчёта изменены», а не
 * «тихим» пересчётом.
 *
 * Форма фильтра — та же, что у расчёта диполей (срез 3.6): в задачу уходит
 * **полоса** `band_min`/`band_max` и сетевой фильтр, а пресеты δ…γ, «одиночная
 * частота» и «свой диапазон» лишь её задают. Ритмы приходят из `/meta`
 * (`freq_bands` — единственный источник, `core/config.py`), а не выдумываются.
 */
import { useQuery } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { api } from '@/shared/api/client'
import {
  BANDWIDTH_RANGE,
  NOTCH_OPTIONS,
  SINGLE_FREQ_RANGE,
  filterBandText,
  filterPresetOptions,
  filterSummary,
  notchOptionValue,
  notchFromOption,
} from '@/shared/lib/calcFilter'
import { EEG_PALETTES, hopMs } from '@/shared/lib/eegSpectrogram'
import { AMPLITUDE_UV_PER_DIV } from '@/shared/lib/eegView'
import { BAND_LABELS } from '@/shared/lib/spectrum'
import {
  EEG_PARAM_DEFAULTS,
  SPECTROGRAM_FMAX_RANGE_HZ,
  SPECTROGRAM_OVERLAP_RANGE_PCT,
  SPECTROGRAM_OVERLAP_STEP_PCT,
  SPECTROGRAM_WINDOW_RANGE_MS,
  SMOOTH_BINS_RANGE,
  SMOOTH_MS_RANGE,
  eegResultMatchesParams,
  useEegParams,
  useEegJobSummary,
} from '@/shared/state/eegParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { FieldRow } from '@/shared/ui/FieldRow'
import { NumberField } from '@/shared/ui/NumberField'
import { Panel } from '@/shared/ui/Panel'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { SelectField } from '@/shared/ui/SelectField'
import { InfoRow } from '@/shared/ui/StateViews'
import { StatusPill } from '@/shared/ui/StatusPill'

/** dB-окно палитры: шаг 5 дБ, диапазон — от пола шкалы до потолка расчёта */
const DB_RANGE_STEP = 5

export function EegPanel() {
  const params = useEegParams((state) => state.params)
  const grid = useEegParams((state) => state.grid)
  const result = useEegParams((state) => state.result)
  const jobSummary = useEegJobSummary()
  const setParams = useEegParams((state) => state.setParams)
  const setChannel = useEegParams((state) => state.setChannel)
  const setSpectrogramParams = useEegParams((state) => state.setSpectrogramParams)
  const setFreqWindow = useEegParams((state) => state.setFreqWindow)
  const setFilterPreset = useEegParams((state) => state.setFilterPreset)
  const setFilterBand = useEegParams((state) => state.setFilterBand)
  const setNotchHz = useEegParams((state) => state.setNotchHz)
  const setSingleFreq = useEegParams((state) => state.setSingleFreq)
  const setBandwidth = useEegParams((state) => state.setBandwidth)
  const recording = useEdfRecording((state) => state.recording)
  const demo = useEdfRecording((state) => state.demo)

  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })
  const freqBands = meta.data?.freq_bands ?? {}
  const channels = recording?.channels ?? demo?.channels ?? []
  const channel = params.channel ?? channels[0] ?? ''
  const presets = filterPresetOptions(freqBands)
  const stale = result !== null && !eegResultMatchesParams(result, params)
  const fullFreq = grid ? ([0, grid.fmaxHz] as [number, number]) : null

  return (
    <div className="flex flex-col gap-3">
      <Panel title="Канал и шкала" hint="Правки только меняют вид: расчёт запускается кнопкой в шапке.">
        <SelectField
          label="Канал"
          value={channel}
          options={channels.map((name) => ({ value: name, label: name }))}
          onChange={setChannel}
          hint={
            channel
              ? 'Спектрограмма считается по одному каналу: у разных каналов разная топография.'
              : 'Каналы появятся после загрузки записи в разделе EDF.'
          }
        />
        <SelectField
          label="Амплитуда"
          value={String(params.amplitudeUv)}
          options={AMPLITUDE_UV_PER_DIV.map((value) => ({
            value: String(value),
            label: `${value} мкВ/дел`,
          }))}
          onChange={(value) => setParams({ amplitudeUv: Number(value) })}
          hint="То же, что перетаскивание правой линейки трека."
        />
        <SegmentedControl
          label="Спектрограмма"
          value={params.spectrogramMode}
          options={[
            { value: 'linked', label: 'Связано с треком', title: 'Показывать то же окно, что и трек' },
            { value: 'overview', label: 'Обзор записи', title: 'Показывать всю запись целиком' },
          ]}
          onChange={(value) => setParams({ spectrogramMode: value })}
        />
        <CheckboxRow
          label="Сетка частот и сетка шкалы"
          checked={params.grid}
          onChange={(checked) => setParams({ grid: checked })}
        />
        <CheckboxRow
          label="Общий курсор"
          checked={params.showCursor}
          onChange={(checked) => setParams({ showCursor: checked })}
          hint="Курсор и линия частоты ставятся кликом по графику или по полосе времени."
        />
        <Button
          icon={<RotateCcw className="size-4" />}
          onClick={() => setParams({ splitRatio: EEG_PARAM_DEFAULTS.splitRatio })}
        >
          Вернуть разделитель на середину
        </Button>
      </Panel>

      <Panel
        title="Спектрограмма"
        hint="Параметры окна STFT уходят в задачу; палитра, окно дБ и сглаживание — только просмотр."
      >
        <NumberField
          label="Окно STFT"
          value={params.spectrogram.windowMs}
          min={SPECTROGRAM_WINDOW_RANGE_MS[0]}
          max={SPECTROGRAM_WINDOW_RANGE_MS[1]}
          step={50}
          unit="мс"
          onChange={(value) => setSpectrogramParams({ windowMs: value })}
          hint={`Длинное окно различает частоты, короткое — моменты времени. Шаг сетки по времени: ${
            grid ? Math.round(hopMs(grid)) : '—'
          } мс.`}
        />
        <NumberField
          label="Перекрытие"
          value={params.spectrogram.overlapPct}
          min={SPECTROGRAM_OVERLAP_RANGE_PCT[0]}
          max={SPECTROGRAM_OVERLAP_RANGE_PCT[1]}
          step={SPECTROGRAM_OVERLAP_STEP_PCT}
          unit="%"
          onChange={(value) => setSpectrogramParams({ overlapPct: value })}
        />
        <NumberField
          label="Верхняя частота"
          value={params.spectrogram.fmaxHz}
          min={SPECTROGRAM_FMAX_RANGE_HZ[0]}
          max={SPECTROGRAM_FMAX_RANGE_HZ[1]}
          step={5}
          unit="Гц"
          onChange={(value) => setSpectrogramParams({ fmaxHz: value })}
        />

        <SelectField
          label="Палитра"
          value={params.palette}
          options={EEG_PALETTES.map((item) => ({ value: item.id, label: item.label }))}
          onChange={(value) => setParams({ palette: value })}
        />
        <NumberField
          label="Окно дБ: низ"
          value={params.dbRangeDb[0]}
          min={-80}
          max={0}
          step={DB_RANGE_STEP}
          unit="дБ"
          onChange={(value) => setParams({ dbRangeDb: [value, params.dbRangeDb[1]] })}
          hint="Отсчёт от потолка шкалы расчёта: всё, что ниже, показывается полом палитры."
        />
        <NumberField
          label="Окно дБ: верх"
          value={params.dbRangeDb[1]}
          min={-60}
          max={20}
          step={DB_RANGE_STEP}
          unit="дБ"
          onChange={(value) => setParams({ dbRangeDb: [params.dbRangeDb[0], value] })}
        />
        <NumberField
          label="Сглаживание времени"
          value={params.smoothMs}
          min={SMOOTH_MS_RANGE[0]}
          max={SMOOTH_MS_RANGE[1]}
          step={50}
          unit="мс"
          onChange={(value) => setParams({ smoothMs: value })}
          hint="Скользящее среднее по уже посчитанным числам — запросов не делает."
        />
        <NumberField
          label="Сглаживание частоты"
          value={params.smoothBins}
          min={SMOOTH_BINS_RANGE[0]}
          max={SMOOTH_BINS_RANGE[1]}
          step={1}
          unit="корзин"
          onChange={(value) => setParams({ smoothBins: value })}
        />
      </Panel>

      <Panel title="Окно частот" hint="Срез уже полученной сетки: запросов не делает.">
        <FieldRow label="Ритмы">
          <div className="flex flex-wrap items-center gap-2">
            {Object.entries(BAND_LABELS).map(([name, label]) => {
              const band = freqBands[name]
              return (
                <Button
                  key={name}
                  disabled={!band}
                  title={
                    band
                      ? `${label}: ${band[0]}–${band[1]} Гц`
                      : 'Диапазоны приходят из метаданных сервера'
                  }
                  onClick={() => setFreqWindow(band ? [band[0], band[1]] : null)}
                >
                  {label}
                </Button>
              )
            })}
            <Button disabled={!fullFreq} onClick={() => setFreqWindow(null)}>
              Весь диапазон
            </Button>
          </div>
        </FieldRow>
        <NumberField
          label="От"
          value={params.freqWindow?.[0] ?? fullFreq?.[0] ?? 0}
          min={0}
          max={params.spectrogram.fmaxHz}
          step={1}
          unit="Гц"
          disabled={!fullFreq}
          onChange={(value) =>
            setFreqWindow([value, params.freqWindow?.[1] ?? fullFreq?.[1] ?? value + 1])
          }
        />
        <NumberField
          label="До"
          value={params.freqWindow?.[1] ?? fullFreq?.[1] ?? params.spectrogram.fmaxHz}
          min={0}
          max={params.spectrogram.fmaxHz}
          step={1}
          unit="Гц"
          disabled={!fullFreq}
          onChange={(value) => setFreqWindow([params.freqWindow?.[0] ?? fullFreq?.[0] ?? 0, value])}
          hint="Тот же масштаб, что у перетаскивания правой линейки спектрограммы."
        />
      </Panel>

      <Panel
        title="Фильтр расчёта"
        hint="В задачу уходит полоса фильтра и сетевой фильтр — как в предподготовке записи."
      >
        <SelectField
          label="Полоса"
          value={params.filter.filterPreset}
          options={presets.map((option) => ({ value: option.value, label: option.label }))}
          onChange={(value) => setFilterPreset(value, freqBands)}
          hint={
            Object.keys(freqBands).length === 0
              ? 'Диапазоны ритмов придут из метаданных сервера.'
              : undefined
          }
        />
        {params.filter.filterPreset === 'custom' ? (
          <>
            <NumberField
              label="Полоса от"
              value={params.filter.filterBandHz?.[0] ?? 1}
              min={0.1}
              max={100}
              step={0.5}
              unit="Гц"
              onChange={(value) => setFilterBand([value, params.filter.filterBandHz?.[1] ?? 40])}
            />
            <NumberField
              label="Полоса до"
              value={params.filter.filterBandHz?.[1] ?? 40}
              min={0.1}
              max={100}
              step={0.5}
              unit="Гц"
              onChange={(value) => setFilterBand([params.filter.filterBandHz?.[0] ?? 1, value])}
            />
          </>
        ) : null}
        {params.filter.filterPreset === 'single' ? (
          <>
            <NumberField
              label="Частота"
              value={params.filter.singleFreqHz}
              min={SINGLE_FREQ_RANGE[0]}
              max={SINGLE_FREQ_RANGE[1]}
              step={0.1}
              unit="Гц"
              onChange={setSingleFreq}
            />
            <NumberField
              label="Ширина"
              value={params.filter.bandwidthHz}
              min={BANDWIDTH_RANGE[0]}
              max={BANDWIDTH_RANGE[1]}
              step={0.1}
              unit="Гц"
              onChange={setBandwidth}
              hint={`В расчёт уходит полоса f ± bw/2 = ${filterBandText(
                params.filter.filterBandHz,
              )}.`}
            />
          </>
        ) : null}
        <SelectField
          label="Сетевой фильтр"
          value={notchOptionValue(params.filter.notchHz)}
          options={NOTCH_OPTIONS}
          onChange={(value) => setNotchHz(notchFromOption(value))}
        />
        <p className="ui-list-row py-1 text-sm text-fg-2">
          {filterSummary(params.filter, freqBands)}
        </p>
      </Panel>

      <Panel title="Состояние расчёта">
        <InfoRow label="Канал результата" value={result?.channel ?? null} mono />
        <InfoRow label="Окно задания" value={result ? `${Math.round(result.window_ms)} мс` : null} />
        <InfoRow label="Перекрытие" value={result ? `${Math.round(result.overlap_pct)} %` : null} />
        <InfoRow label="Верхняя частота" value={result ? `${result.fmax_hz} Гц` : null} />
        <InfoRow label="Сетка" value={grid ? `${grid.nFreqs} × ${grid.nTimes}` : null} />
        <InfoRow label="Задача" value={jobSummary} />
        {stale ? (
          <StatusPill className="mt-2" tone="warn">
            параметры расчёта изменены — результат не пересчитан
          </StatusPill>
        ) : null}
      </Panel>
    </div>
  )
}
