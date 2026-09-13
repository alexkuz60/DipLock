/**
 * Панель опций раздела EDF: параметры просмотра и предподготовки записи.
 *
 * Панель только собирает выбор пользователя (zustand `edfParams`) и показывает,
 * что результат расчёта устарел. Ни один контрол не запускает обработку:
 * расчёт идёт отдельной задачей строго по кнопке (правило в `docs/ui.md`).
 *
 * Значения по умолчанию приходят из `/api/v1/meta` (пороги, длины эпох, каналы
 * монтажа) — конфигурация остаётся в `backend/.env`, UI её не дублирует.
 */
import { useQuery } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import { api } from '@/shared/api/client'
import { RecalcProgress } from './EdfToolActions'
import {
  ARTIFACT_COLORS,
  ARTIFACT_KINDS,
  ARTIFACT_LABELS,
  EDF_UNITS_OPTIONS,
  FILTER_PRESETS,
  RECALC_STAGES,
  RECALC_STAGE_LABELS,
  TIME_LEVELS,
  useEdfParams,
  useEdfParamsValue,
  useEdfRecalcStatus,
  type AmplitudeMode,
  type EdfUnits,
  type FilterPresetId,
  type ReferenceMode,
} from '@/shared/state/edfParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { NumberField } from '@/shared/ui/NumberField'
import { Panel } from '@/shared/ui/Panel'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { SelectField } from '@/shared/ui/SelectField'
import { StatusPill } from '@/shared/ui/StatusPill'
import { InfoRow, LoadingBlock } from '@/shared/ui/StateViews'

const AMPLITUDE_MODES: { value: AmplitudeMode; label: string; title: string }[] = [
  { value: 'shared', label: 'Общий', title: 'Одна шкала мкВ/дел для всех каналов' },
  { value: 'per_channel', label: 'Авто', title: 'Своя шкала у каждого канала' },
]

const REFERENCE_MODES: { value: ReferenceMode; label: string; title: string }[] = [
  { value: 'average', label: 'Средний', title: 'Average reference по всем каналам' },
  { value: 'custom', label: 'По каналам', title: 'Референс по выбранным каналам (блок «Каналы»)' },
]

const NOTCH_OPTIONS = [
  { value: '0', label: 'Выключен' },
  { value: '50', label: '50 Гц (Европа)' },
  { value: '60', label: '60 Гц (США)' },
]

/** Пояснение к кнопкам расчёта: обработка не запускается сама по себе */
const RECALC_HINT =
  'Расчёт запускается только кнопками шапки раздела — правка параметров ничего не пересчитывает. Каждая кнопка считает одну стадию на сервере и заменяет её слой в треках результатом.'

export function EdfPanel() {
  const params = useEdfParamsValue()
  const setParams = useEdfParams((state) => state.setParams)
  const availableChannels = useEdfParams((state) => state.availableChannels)
  const toggleChannel = useEdfParams((state) => state.toggleChannel)
  const resetToDefaults = useEdfParams((state) => state.resetToDefaults)
  const recording = useEdfRecording((state) => state.recording)
  const demo = useEdfRecording((state) => state.demo)
  const stageJobs = useEdfRecording((state) => state.stageJobs)
  const passport = useEdfRecording((state) => state.passport)
  const setPassport = useEdfRecording((state) => state.setPassport)
  const recalc = useEdfRecalcStatus()

  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })

  // Пока запись не загружена, показываем монтаж 10-20 из конфигурации сервера —
  // панель должна быть осмысленной до загрузки файла.
  const channels = availableChannels.length
    ? availableChannels
    : (meta.data?.standard_channels ?? [])
  const epochLengths = meta.data?.epoch_lengths_ms ?? []
  const epochOptions = (epochLengths.length ? epochLengths : [params.epochLengthMs]).map((value) => ({
    value: String(value),
    label: `${value} мс`,
  }))

  const status = { tone: recalc.tone, text: recalc.text }
  const stageHint = RECALC_STAGES.map(
    (stage) =>
      `${RECALC_STAGE_LABELS[stage]} — ${
        recalc.states[stage] === 'ready'
          ? 'рассчитано'
          : recalc.states[stage] === 'stale'
            ? 'параметры изменены'
            : 'не рассчитано'
      }`,
  ).join('; ')

  // Ошибки стадий (срез 2.7): задача упала — панель объясняет это текстом,
  // а не только красной точкой на кнопке.
  const stageErrors = RECALC_STAGES.flatMap((stage) => {
    const job = stageJobs[stage]
    return job?.status === 'failed' && job.error ? [{ stage, message: job.error }] : []
  })

  return (
    <>
      <Panel title="Запись">
        {meta.isPending ? <LoadingBlock label="Чтение параметров сервера…" /> : null}
        {recording ? (
          <>
            <InfoRow label="Файл" value={recording.filename} mono />
            <InfoRow label="Каналов" value={recording.n_channels} />
            <InfoRow label="Частота дискретизации" value={`${recording.sfreq} Гц`} mono />
            <InfoRow label="Длина сессии" value={`${recording.duration_sec} с`} mono />
            {recording.units_autoscaled ? (
              <div className="mt-2">
                <StatusPill tone="warn">Единицы масштабированы в µV автоматически</StatusPill>
              </div>
            ) : null}
            {demo ? <InfoRow label="Рабочая область" value="демо-сигнал (синтетика)" /> : null}
            {recording.warnings.length ? (
              <div className="mt-2 space-y-1">
                {recording.warnings.map((warning) => (
                  <StatusPill key={warning} tone="warn">
                    {warning}
                  </StatusPill>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <InfoRow label="Файл" value="не загружен" />
        )}

        <div className="mt-2">
          <SelectField
            label="Единицы в БД"
            value={passport.units}
            options={EDF_UNITS_OPTIONS}
            disabled={recording === null}
            hint="Формат амплитуды при занесении данных в БД: EDF-файл не перезаписывается."
            onChange={(value: EdfUnits) => setPassport({ units: value })}
          />
        </div>
      </Panel>

      <Panel title="Фильтры и референс">
        <SelectField
          label="Полоса"
          value={params.filterPreset}
          options={FILTER_PRESETS.map((preset) => ({ value: preset.value, label: preset.label }))}
          onChange={(value) => setParams({ filterPreset: value as FilterPresetId })}
        />
        {params.filterPreset === 'custom' ? (
          <>
            <NumberField
              label="От"
              value={params.customBand[0]}
              min={0}
              max={params.customBand[1]}
              step={0.5}
              unit="Гц"
              onChange={(value) => setParams({ customBand: [value, params.customBand[1]] })}
            />
            <NumberField
              label="До"
              value={params.customBand[1]}
              min={params.customBand[0]}
              max={200}
              step={0.5}
              unit="Гц"
              onChange={(value) => setParams({ customBand: [params.customBand[0], value] })}
            />
          </>
        ) : null}
        <SelectField
          label="Notch"
          value={String(params.notchHz)}
          options={NOTCH_OPTIONS}
          onChange={(value) => setParams({ notchHz: Number(value) })}
        />
        <SegmentedControl
          label="Референс"
          value={params.reference}
          options={REFERENCE_MODES}
          onChange={(value) => setParams({ reference: value })}
          hint="Референс применяется при предподготовке записи."
        />
      </Panel>

      <Panel title="Пороги артефактов" hint="Значения по умолчанию — из backend/.env.">
        <NumberField
          label="z-score"
          value={params.zScoreThreshold}
          min={1}
          max={20}
          step={0.5}
          onChange={(value) => setParams({ zScoreThreshold: value })}
        />
        <NumberField
          label="peak-to-peak"
          value={params.peakToPeakUv}
          min={1}
          max={1000}
          step={5}
          unit="мкВ"
          onChange={(value) => setParams({ peakToPeakUv: value })}
        />
        <NumberField
          label="flat-line"
          value={params.flatLineUv}
          min={0}
          max={100}
          step={1}
          unit="мкВ"
          onChange={(value) => setParams({ flatLineUv: value })}
        />
        <NumberField
          label="Длительность"
          value={params.flatLineMs}
          min={20}
          max={5000}
          step={10}
          unit="мс"
          hint="Минимальная длительность плоского участка для срабатывания детектора."
          onChange={(value) => setParams({ flatLineMs: value })}
        />
      </Panel>

      <Panel
        title="Эпохи"
        hint="Границы рисуются по выбранной длине эпохи; отброшенные эпохи помечаются штриховкой по результату стадии (срез 2.6 — демо-фикстура)."
      >
        <SelectField
          label="Длина эпохи"
          value={String(params.epochLengthMs)}
          options={epochOptions}
          disabled={epochLengths.length === 0}
          onChange={(value) => setParams({ epochLengthMs: Number(value) })}
          hint={
            epochLengths.length === 0
              ? 'Список длин придёт из /meta после ответа сервера.'
              : undefined
          }
        />
        <CheckboxRow
          label="Маркеры границ эпох"
          checked={params.epochBoundaries}
          onChange={(checked) => setParams({ epochBoundaries: checked })}
        />
        <CheckboxRow
          label="Штриховка отброшенных эпох"
          checked={params.droppedEpochsHatched}
          onChange={(checked) => setParams({ droppedEpochsHatched: checked })}
        />
      </Panel>

      <Panel
        title="Каналы"
        hint={`Выбрано ${params.visibleChannels.length} из ${channels.length}.${
          availableChannels.length ? '' : ' Показан монтаж 10-20 по умолчанию.'
        }`}
      >
        <div className="mb-1 flex gap-2">
          <Button variant="ghost" onClick={() => setParams({ visibleChannels: [...channels] })}>
            Все
          </Button>
          <Button variant="ghost" onClick={() => setParams({ visibleChannels: [] })}>
            Ничего
          </Button>
        </div>
        {channels.map((name) => (
          <CheckboxRow
            key={name}
            mono
            label={name}
            checked={params.visibleChannels.includes(name)}
            onChange={() => toggleChannel(name)}
          />
        ))}
      </Panel>

      <Panel title="Отображение">
        <SegmentedControl
          label="Амплитуда"
          value={params.amplitudeMode}
          options={AMPLITUDE_MODES}
          onChange={(value) => setParams({ amplitudeMode: value })}
        />
        {params.amplitudeMode === 'shared' ? (
          <NumberField
            label="Масштаб"
            value={params.amplitudeScaleUv}
            min={1}
            max={1000}
            step={5}
            unit="мкВ/дел"
            onChange={(value) => setParams({ amplitudeScaleUv: value })}
          />
        ) : null}
        <SegmentedControl
          label="Время"
          value={String(params.timeLevel)}
          options={TIME_LEVELS.map((factor, index) => ({
            value: String(index),
            label: `×${factor}`,
            title: factor === 1 ? 'Вся сессия' : `Детализация ×${factor} (min/max-огибающая)`,
          }))}
          onChange={(value) => setParams({ timeLevel: Number(value) })}
        />
      </Panel>

      <Panel
        title="Единицы EDF"
        hint="Файлы без physical dimension MNE читает как «вольты» (в 1e6 раз больше). Авто-детект исправляет масштаб; ручной выбор нужен, если он ошибается."
      >
        <SelectField
          label="Единицы"
          value={params.edfUnits}
          options={EDF_UNITS_OPTIONS}
          onChange={(value) => setParams({ edfUnits: value })}
        />
      </Panel>

      <Panel
        title="Легенда артефактов"
        hint="Срез 2.6: зоны рисуются из демо-фикстуры, пока поиск артефактов не подключён к серверу (срез 2.7). Цвет зоны и число совпадают с легендой над треками."
      >
        {ARTIFACT_KINDS.map((kind) => (
          <CheckboxRow
            key={kind}
            label={ARTIFACT_LABELS[kind]}
            swatch={ARTIFACT_COLORS[kind]}
            checked={params.artifactVisibility[kind]}
            onChange={(checked) =>
              setParams({
                artifactVisibility: { ...params.artifactVisibility, [kind]: checked },
              })
            }
          />
        ))}
      </Panel>

      <Panel title="Запуск">
        {recording || demo ? (
          <>
            <StatusPill tone={status.tone}>{status.text}</StatusPill>
            <div className="mt-3">
              <RecalcProgress label="Готовность перерасчётов в панели" />
            </div>
            <p className="mt-2 text-sm text-fg-2" title={stageHint}>
              Стадии: {stageHint}.
            </p>
            {stageErrors.length ? (
              <div className="mt-2 space-y-1">
                {stageErrors.map(({ stage, message }) => (
                  <StatusPill key={stage} tone="danger">
                    {RECALC_STAGE_LABELS[stage]}: {message}
                  </StatusPill>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-fg-2">Запись не загружена — пересчитывать пока нечего.</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            icon={<RotateCcw className="size-4" />}
            onClick={() => resetToDefaults(meta.data ?? null)}
            title="Вернуть пороги, длины эпох и монтаж из конфигурации сервера"
          >
            К значениям сервера
          </Button>
        </div>
        <p className="mt-2 text-sm text-fg-2">{RECALC_HINT}</p>
      </Panel>
    </>
  )
}
