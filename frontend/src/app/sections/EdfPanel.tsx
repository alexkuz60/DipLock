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
  CLEAN_METHOD_OPTIONS,
  EDF_UNITS_OPTIONS,
  FILTER_PRESETS,
  RECALC_STAGES,
  RECALC_STAGE_LABELS,
  TIME_LEVELS,
  useEdfParams,
  useEdfParamsValue,
  useEdfRecalcStatus,
  type AmplitudeMode,
  type EpochMode,
  type ErpBaselineMode,
  type FilterPresetId,
  type ReferenceMode,
} from '@/shared/state/edfParams'
import { filterBandOf, useEdfRecording } from '@/shared/state/edfRecording'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { EvokedChart } from '@/shared/ui/EvokedChart'
import { FilterResponse } from '@/shared/ui/FilterResponse'
import { NumberField } from '@/shared/ui/NumberField'
import { Panel } from '@/shared/ui/Panel'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { SelectField } from '@/shared/ui/SelectField'
import { StatusPill } from '@/shared/ui/StatusPill'
import { TextField } from '@/shared/ui/TextField'

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

const EPOCH_MODES: { value: EpochMode; label: string; title: string }[] = [
  {
    value: 'fixed',
    label: 'Фиксированные',
    title: 'Эпохи равной длины без наложения (прежний режим нарезки)',
  },
  {
    value: 'events',
    label: 'По событиям',
    title:
      'Окна вокруг событий записи (аннотации EDF+ и маркеры стим-каналов) — нарезка для ERP',
  },
]

const ERP_BASELINE_MODES: { value: ErpBaselineMode; label: string; title: string }[] = [
  { value: 'none', label: 'Без коррекции', title: 'Усреднение без baseline-коррекции' },
  {
    value: 'minus200',
    label: '−200…0 мс',
    title: 'Вычитание среднего по окну −200…0 мс до события (нужно pre-окно ≥ 200 мс)',
  },
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
  /** Ручные пометки эпох живут при записи (Ctrl+двойной клик во вьюере, срез 2.10) */
  const manualMarks = useEdfRecording((state) => state.epochMarks)
  /** Числа QC и отчёт очистки приходят результатами стадий (этапы «числа QC» и 4) */
  const qcSummary = useEdfRecording((state) => state.qcSummary)
  const cleanReport = useEdfRecording((state) => state.cleanReport)
  /** Паспорт фильтра стадии filter (шаг 2.5): метод/ядро/буфер краёв (N11/N12) */
  const filterDesign = useEdfRecording((state) => state.filterDesign)
  const clearEpochMarks = useEdfRecording((state) => state.clearEpochMarks)
  const recalc = useEdfRecalcStatus()
  /** Задача ERP (шаг 2.7): считает только кнопка, правка параметров — нет */
  const evoked = useEdfRecording((state) => state.evoked)
  const startEvoked = useEdfRecording((state) => state.startEvoked)

  /** События записи (N2/2.7): источник селектов нарезки и ERP */
  const eventOptions = Object.entries(recording?.event_counts ?? {}).map(
    ([description, count]) => ({ value: description, label: `${description} — ${count}` }),
  )

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
  /** Канал графика ERP: свой выбор, иначе первый видимый канал */
  const erpChannel = params.erpChannel || params.visibleChannels[0] || channels[0] || ''
  const channelOptions = channels.map((name) => ({ value: name, label: name }))
  /** ERP требует событийный режим и выбранное событие (иначе кнопка disabled) */
  const canRunErp = Boolean(recording) && params.epochMode === 'events' && params.eventId !== ''
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
  /**
   * Подсказка панели «Эпохи» до расчёта честная: штриховки ещё нет, потому что
   * вердикты reject-фильтра приходят только с результатом стадии. Прежний текст
   * обещал «эпохи, исключённые из расчёта» и выдавал демо-фикстуру за расчёт
   * (ручная проверка, 19.09.2026).
   */
  const epochsHint =
    recalc.states.epochs === 'not_run'
      ? 'Границы рисуются по выбранной длине эпохи; штриховки пока нет — эпохи, исключённые из расчёта, появятся после кнопки «Нарезка эпох» в шапке. Ctrl+двойной клик по треку переключает блокировку эпохи под курсором: так ставится своя правка.'
      : 'Границы рисуются по длине эпохи результата. Штриховка — эпохи, исключённые из расчёта: решение reject-фильтра и ваши правки. Ctrl+двойной клик по треку переключает блокировку эпохи под курсором: так снимается штриховка алгоритма и ставится своя.'

  // Ошибки стадий (срез 2.7): задача упала — панель объясняет это текстом,
  // а не только красной точкой на кнопке.
  const stageErrors = RECALC_STAGES.flatMap((stage) => {
    const job = stageJobs[stage]
    return job?.status === 'failed' && job.error
      ? [{ stage, message: job.error, traceback: job.errorTraceback }]
      : []
  })

  return (
    <>
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
        <NumberField
          label="Гармоники notch"
          value={params.notchHarmonics}
          min={0}
          max={4}
          step={1}
          hint="Доп. частоты 100/150/200/240 Гц (гармоники сети 50/60 Гц); 0 — только основная."
          onChange={(value) => setParams({ notchHarmonics: value })}
        />
        <SegmentedControl
          label="Очистка"
          value={params.cleanMethod}
          options={CLEAN_METHOD_OPTIONS}
          onChange={(value) => setParams({ cleanMethod: value })}
          hint={
            params.cleanMethod === 'ssp'
              ? 'SSP — экспериментально: проекторы необратимы и режут подпространство сигнала целиком. Предпочтительнее ICA.'
              : 'Метод артефактуальной очистки: ICA удаляет EOG/ECG-компоненты (ica.apply) и отчитывается, сколько удалено.'
          }
        />
        {params.cleanMethod === 'ica' ? (
          <NumberField
            label="Компонент ICA"
            value={params.icaNComponents}
            min={0}
            max={64}
            step={1}
            hint="0 — авто (MNE выберет число по данным)."
            onChange={(value) => setParams({ icaNComponents: value })}
          />
        ) : null}
        <TextField
          label="Плохие каналы"
          mono
          value={params.badChannels}
          placeholder="C3, T7"
          hint="Имена через запятую — каналы для интерполяции (авто-список QC — в легенде артефактов)."
          onChange={(value) => setParams({ badChannels: value })}
        />
        <CheckboxRow
          label="Интерполировать bad"
          checked={params.interpolateBads}
          onChange={(checked) => setParams({ interpolateBads: checked })}
        />
        {cleanReport ? (
          <p className="mt-1 text-sm text-fg-2" data-testid="clean-report">
            Очистка:
            {cleanReport.n_components_removed
              ? ` ICA −${cleanReport.n_components_removed} комп. (индексы: ${cleanReport.removed_components.join(', ')})`
              : ''}
            {cleanReport.n_projectors ? ` SSP: ${cleanReport.n_projectors} проекторов` : ''}
            {cleanReport.interpolated_channels.length
              ? ` интерполировано: ${cleanReport.interpolated_channels.join(', ')}`
              : ''}
            {cleanReport.amplitude_p95_uv_before !== null &&
            cleanReport.amplitude_p95_uv_after !== null
              ? ` (p95 ${cleanReport.amplitude_p95_uv_before} → ${cleanReport.amplitude_p95_uv_after} мкВ)`
              : ''}
          </p>
        ) : null}
        {filterDesign ? (
          <p className="mt-1 text-sm text-fg-2" data-testid="filter-passport">
            Фильтр расчёта:{' '}
            {filterDesign.method === 'none'
              ? 'без полосового фильтра'
              : filterDesign.method === 'fir'
                ? `FIR, ядро ${filterDesign.lengthSec?.toFixed(2) ?? '?'} с, краевой буфер ±${filterDesign.edgeBufferSec.toFixed(2)} с (эпохи у краёв — BAD_edge)`
                : 'IIR (узкая полоса, zero-phase) — края записи не режутся'}
            {' — применяется только в расчётах; треки вьюера остаются исходными.'}
          </p>
        ) : null}
        <FilterResponse
          band={filterBandOf(params)}
          notchHz={params.notchHz ? params.notchHz : null}
          notchHarmonics={params.notchHarmonics}
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
        <CheckboxRow
          label="Искать EOG-компоненты ICA"
          checked={params.runIca}
          hint="Тяжёлая ветка (ICA по всей записи). EOG-компоненты ищутся по EOG-каналам записи или фронтальному прокси Fp1/Fp2."
          onChange={(checked) => setParams({ runIca: checked })}
        />
      </Panel>

      <Panel title="Эпохи" hint={epochsHint}>
        <SegmentedControl
          label="Режим нарезки"
          value={params.epochMode}
          options={EPOCH_MODES}
          onChange={(value) =>
            // Событие подставляем сразу при включении режима (N2/2.7): пустой выбор
            // давал 400 «требует event_id» при нажатии «Нарезка эпохи»
            setParams(
              value === 'events' && !params.eventId && eventOptions.length > 0
                ? { epochMode: value, eventId: eventOptions[0]!.value }
                : { epochMode: value },
            )
          }
        />
        {params.epochMode === 'events' ? (
          <>
            <SelectField
              label="Событие"
              value={params.eventId}
              options={eventOptions}
              disabled={eventOptions.length === 0}
              onChange={(value) => setParams({ eventId: value })}
              hint={
                eventOptions.length === 0
                  ? 'В записи нет событий: EDF+-аннотаций и маркеров стим-каналов не найдено.'
                  : 'Описание события из паспорта записи — вокруг его моментов режутся эпохи.'
              }
            />
            <NumberField
              label="До события"
              value={params.epochPreMs}
              min={0}
              max={10000}
              step={50}
              unit="мс"
              hint="Пре-стимульное окно (tmin = −pre/1000 с); для ERP обычно 100–200 мс."
              onChange={(value) => setParams({ epochPreMs: value })}
            />
            <NumberField
              label="После события"
              value={params.epochPostMs}
              min={100}
              max={10000}
              step={50}
              unit="мс"
              hint="Пост-стимульное окно (tmax = +post/1000 с); для ERP обычно 500–1000 мс."
              onChange={(value) => setParams({ epochPostMs: value })}
            />
          </>
        ) : (
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
        )}
        <CheckboxRow
          label="Маркеры событий"
          checked={params.eventsLayer}
          hint="Слой событий записи (аннотации EDF+ и маркеры стим-каналов) поверх треков: линии с тултипом «описание, время»."
          onChange={(checked) => setParams({ eventsLayer: checked })}
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
        <div className="mt-2 flex items-center gap-2">
          <StatusPill tone={manualMarks.length ? 'warn' : 'neutral'}>
            Ручных пометок: {manualMarks.length}
          </StatusPill>
          <Button
            variant="ghost"
            disabled={manualMarks.length === 0}
            title="Вернуть разметку эпох к решению reject-фильтра"
            onClick={clearEpochMarks}
          >
            Снять
          </Button>
        </div>
      </Panel>

      <Panel
        title="ERP (усреднение по событиям)"
        hint="Стимул → эпоха → усреднение: волна по каналам вокруг момента события (шаг 2.7). Считает только кнопка; событие и окно — из блока «Эпохи» (режим «По событиям»)."
      >
        <SegmentedControl
          label="Baseline"
          value={params.erpBaseline}
          options={ERP_BASELINE_MODES}
          onChange={(value) => setParams({ erpBaseline: value })}
          hint={
            params.erpBaseline === 'minus200' && params.epochPreMs < 200
              ? 'Pre-окно меньше 200 мс: baseline не влезает в эпоху и будет пропущен.'
              : undefined
          }
        />
        <SelectField
          label="Канал графика"
          value={erpChannel}
          options={channelOptions}
          onChange={(value) => setParams({ erpChannel: value })}
          hint="Какой канал усреднённой волны показать графиком (остальные — в ответе задачи)."
        />
        <Button
          variant="primary"
          disabled={!canRunErp || evoked.status === 'running'}
          title={
            canRunErp
              ? 'Рассчитать усреднённую ERP-волну по выбранному событию'
              : 'Включите режим «По событиям» и выберите событие в блоке «Эпохи»'
          }
          onClick={() => void startEvoked()}
        >
          {evoked.status === 'running' ? 'Считаем…' : 'Усреднить (ERP)'}
        </Button>
        {evoked.status === 'running' ? (
          <StatusPill tone="accent">
            Прогресс: {Math.round(evoked.progress * 100)} %
            {evoked.message ? ` — ${evoked.message}` : ''}
          </StatusPill>
        ) : null}
        {evoked.error ? (
          <p className="text-sm text-danger" data-testid="evoked-error">
            {evoked.error}
          </p>
        ) : null}
        {evoked.result ? (
          <div data-testid="evoked-result">
            <StatusPill tone={evoked.result.n_used > 0 ? 'ok' : 'warn'}>
              Событий в среднем: {evoked.result.n_used} из {evoked.result.n_total}
            </StatusPill>
            <EvokedChart result={evoked.result} channel={erpChannel} />
            <p className="text-xs text-fg-2">
              {evoked.result.event_id}: окно −{Math.round(-evoked.result.tmin * 1000)}/
              {Math.round(evoked.result.tmax * 1000)} мс от события
              {evoked.result.baseline
                ? `, baseline ${Math.round(evoked.result.baseline[0] * 1000)}…${Math.round(evoked.result.baseline[1] * 1000)} мс`
                : ', без baseline'}
              {evoked.result.rejected_epochs.length
                ? `, отброшено событий: ${evoked.result.rejected_epochs.length}`
                : ''}
              . Ось: мс от события (0 — стимул), мкВ.
            </p>
            {evoked.result.warnings.map((warning) => (
              <p key={warning} className="text-xs text-warn">
                {warning}
              </p>
            ))}
          </div>
        ) : null}
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
        hint="Цвет зоны и число совпадают с легендой над треками. Чекбоксы управляют видимостью слоёв и расчёт не запускают; у записи зоны появятся после стадии «Поиск артефактов», в демо-режиме это фикстура."
      >
        {qcSummary ? (
          <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="qc-summary">
            {/* Светофор записи (шаг 2.2): вердикт сервера по категориям
                «чистые данные / 50 Гц / SNR / плохие каналы», причины — в тултипе */}
            <StatusPill
              tone={
                qcSummary.recordStatus === 'ok'
                  ? 'ok'
                  : qcSummary.recordStatus === 'warn'
                    ? 'warn'
                    : 'danger'
              }
              title={
                qcSummary.recordStatusReasons.join('; ') ||
                'Качество записи в норме по всем категориям'
              }
            >
              Светофор:{' '}
              {qcSummary.recordStatus === 'ok'
                ? 'в норме'
                : qcSummary.recordStatus === 'warn'
                  ? 'внимание'
                  : 'плохо'}
            </StatusPill>
            {qcSummary.snrDbMedian !== null ? (
              <StatusPill
                tone={
                  qcSummary.snrDbMedian < 5
                    ? 'danger'
                    : qcSummary.snrDbMedian < 10
                      ? 'warn'
                      : 'ok'
                }
                title="SNR: мощность 2–30 Гц против высокочастотного шума (дБ, медиана по каналам)"
              >
                SNR: {qcSummary.snrDbMedian} дБ
              </StatusPill>
            ) : null}
            <StatusPill tone={qcSummary.goodDataPercent >= 80 ? 'ok' : 'warn'}>
              Чистых данных: {Math.round(qcSummary.goodDataPercent)}%
            </StatusPill>
            {qcSummary.lineNoiseLevel !== null ? (
              <StatusPill tone={qcSummary.lineNoiseLevel >= 4 ? 'warn' : 'neutral'}>
                50/60 Гц: ×{qcSummary.lineNoiseLevel}
              </StatusPill>
            ) : null}
            {qcSummary.deadChannels.length ? (
              <Button
                variant="ghost"
                title="Мёртвые каналы: константные до референса (отвалившийся электрод) — подставить в опцию интерполяции"
                onClick={() =>
                  setParams({
                    badChannels: Array.from(
                      new Set([
                        ...params.badChannels.split(',').map((s) => s.trim()),
                        ...qcSummary.deadChannels,
                      ]),
                    )
                      .filter(Boolean)
                      .join(', '),
                  })
                }
              >
                Мёртвые каналы: {qcSummary.deadChannels.join(', ')}
              </Button>
            ) : null}
            {qcSummary.badChannels.length ? (
              <Button
                variant="ghost"
                title="Подставить авто-список плохих каналов в опцию интерполяции"
                onClick={() => setParams({ badChannels: qcSummary.badChannels.join(', ') })}
              >
                Плохие каналы: {qcSummary.badChannels.join(', ')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {/* `ica_eog` не показываем: зона контрактом не создаётся (компоненты ICA
            не привязаны ко времени), у слоя нет видимости — счётчик компонент
            показывает чип легенды над треками */}
        {ARTIFACT_KINDS.filter((kind) => kind !== 'ica_eog').map((kind) => (
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
                {stageErrors.map(({ stage, message, traceback }) => (
                  <div key={stage}>
                    <StatusPill tone="danger">
                      {RECALC_STAGE_LABELS[stage]}: {message}
                    </StatusPill>
                    {traceback ? (
                      <details className="mt-1 text-xs text-fg-2" data-testid={`stage-traceback-${stage}`}>
                        <summary className="cursor-pointer">Технические детали ошибки</summary>
                        <pre className="mt-1 max-h-48 overflow-auto rounded-sm bg-bg-2 p-2 whitespace-pre-wrap">
                          {traceback}
                        </pre>
                      </details>
                    ) : null}
                  </div>
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
