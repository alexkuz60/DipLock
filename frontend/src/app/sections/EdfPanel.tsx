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
import { RotateCcw, Sigma } from 'lucide-react'
import { api } from '@/shared/api/client'
import {
  ARTIFACT_KINDS,
  ARTIFACT_LABELS,
  FILTER_PRESETS,
  TIME_LEVELS,
  useEdfApplied,
  useEdfDirty,
  useEdfParams,
  useEdfParamsValue,
  type AmplitudeMode,
  type EdfUnits,
  type FilterPresetId,
  type ReferenceMode,
} from '@/shared/state/edfParams'
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

const EDF_UNIT_OPTIONS: { value: EdfUnits; label: string }[] = [
  { value: 'auto', label: 'Авто (по масштабу файла)' },
  { value: 'V', label: 'Вольты (V)' },
  { value: 'mV', label: 'Милливольты (mV)' },
  { value: 'uV', label: 'Микровольты (µV)' },
]

/** Пояснение к кнопке расчёта: обработка не запускается сама по себе */
const RECALC_HINT =
  'Расчёт запускается только этой кнопкой — правка параметров ничего не пересчитывает. Задача предподготовки (артефакты + эпохи) ещё не подключена к серверу, поэтому кнопка неактивна.'

export function EdfPanel() {
  const params = useEdfParamsValue()
  const setParams = useEdfParams((state) => state.setParams)
  const availableChannels = useEdfParams((state) => state.availableChannels)
  const toggleChannel = useEdfParams((state) => state.toggleChannel)
  const resetToDefaults = useEdfParams((state) => state.resetToDefaults)
  const applied = useEdfApplied()
  const dirty = useEdfDirty()

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

  const status =
    applied === null
      ? { tone: 'neutral' as const, text: 'Результат не рассчитан' }
      : dirty
        ? { tone: 'warn' as const, text: 'Параметры изменены — результат не пересчитан' }
        : { tone: 'ok' as const, text: 'Результат соответствует параметрам' }

  return (
    <>
      <Panel title="Запись">
        {meta.isPending ? <LoadingBlock label="Чтение параметров сервера…" /> : null}
        <InfoRow label="Файл" value={availableChannels.length ? 'загружен' : 'не загружен'} />
        <InfoRow label="Каналов в записи" value={availableChannels.length || null} />
        <p className="mt-1 text-sm text-fg-2">
          Загрузка EDF появится в рабочей области; параметры ниже сохраняются и применяются к
          загрузке.
        </p>
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

      <Panel title="Эпохи">
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
          options={EDF_UNIT_OPTIONS}
          onChange={(value) => setParams({ edfUnits: value })}
        />
      </Panel>

      <Panel title="Легенда артефактов">
        {ARTIFACT_KINDS.map((kind) => (
          <CheckboxRow
            key={kind}
            label={ARTIFACT_LABELS[kind]}
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
        <StatusPill tone={status.tone}>{status.text}</StatusPill>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" icon={<Sigma className="size-4" />} disabled title={RECALC_HINT}>
            Пересчитать предподготовку
          </Button>
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
