/**
 * Раздел EDF: загрузка записи (drag & drop) и просмотр сырых треков.
 *
 * Обработки здесь нет: загрузка возвращает только паспорт записи
 * (`POST /api/v1/recordings`), поэтому пользователь сначала видит сигнал как он
 * есть и уже по картинке решает, нужна ли обработка артефактов и шума.
 *
 * Треки берутся из эндпоинта сигналов (`GET /recordings/{id}/signals?level=`,
 * срез 2.5): уровень зума — индекс в `TIME_LEVELS`, кадры кэшируются в сторе
 * записи. Пока нужный уровень грузится, показывается самый подробный из уже
 * загруженных — переключение зума не мигает пустотой.
 *
 * Диалог выбора EDF один на раздел: его открывают и кнопка в зоне загрузки,
 * и иконка «Загрузить EDF» в тулс-хедере (через `fileDialogRequest` — счётчик
 * запросов: диалог открывается на его **изменение**, поэтому возврат в раздел
 * с уже накопленным запросом файл не переспрашивает).
 */
import { useQuery } from '@tanstack/react-query'
import { FileUp, FlaskConical, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent, type RefObject } from 'react'
import { api } from '@/shared/api/client'
import type { RecordingMeta } from '@/shared/api/types'
import { DEMO_CHANNELS } from '@/shared/lib/demoSignal'
import { selectFrame, resolveSignalLevel } from '@/shared/lib/signalFrame'
import { eventMarks } from '@/shared/lib/viewerLayers'
import { acceptEdfFile, useEdfRecording } from '@/shared/state/edfRecording'
import { TIME_LEVELS, useEdfParams } from '@/shared/state/edfParams'
import { Button } from '@/shared/ui/Button'
import { cx } from '@/shared/ui/cx'
import { Panel } from '@/shared/ui/Panel'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { TrackStack } from './viewer/TrackStack'

/** Скрытый input записи: открывается кнопкой тулс-хедера или зоны загрузки. */
function FileDialogInput({
  inputRef,
  request,
}: {
  inputRef: RefObject<HTMLInputElement | null>
  request: number
}) {
  /**
   * Последний обработанный запрос. Инициализируется текущим: счётчик
   * `fileDialogRequest` живёт в сторе записи и не сбрасывается, поэтому при
   * возврате в раздел («ЭЭГ» → «EDF») компонент монтируется заново при
   * `request > 0`, и проверка «есть запрос — открыть диалог» показывала выбор
   * файла поверх уже открытой записи (ручная проверка, 18.09.2026). Запрос
   * должен срабатывать только на **изменение** счётчика — тот же приём, что у
   * `handledNavSeqRef` в `TrackStack`/`EegSection`.
   */
  const handledRequestRef = useRef(request)
  useEffect(() => {
    if (request === handledRequestRef.current) return
    handledRequestRef.current = request
    inputRef.current?.click()
  }, [inputRef, request])

  return (
    <input
      ref={inputRef}
      type="file"
      accept=".edf"
      className="hidden"
      aria-label="Выбрать файл EDF"
      onChange={(event) => {
        acceptEdfFile(event.target.files?.[0])
        event.target.value = ''
      }}
    />
  )
}

function Dropzone({
  channels,
  uploading,
  inputRef,
}: {
  channels: string[]
  uploading: number | null
  inputRef: RefObject<HTMLInputElement | null>
}) {
  const openDemo = useEdfRecording((state) => state.openDemo)
  const [dragOver, setDragOver] = useState(false)

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDragOver(false)
    acceptEdfFile(event.dataTransfer.files[0])
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-3">
      <div
        onDrop={onDrop}
        onDragOver={(event) => {
          event.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        className={cx(
          'flex w-full max-w-2xl flex-col items-center gap-4 rounded-2xl border-2 border-dashed p-10 text-center transition-colors',
          dragOver ? 'border-accent bg-accent-soft/30' : 'border-border bg-bg-1',
        )}
      >
        <FileUp className="size-12 text-fg-2" aria-hidden />
        <div>
          <h2 className="text-xl font-semibold text-fg-0">Файл записи не загружен</h2>
          <p className="mt-1 text-sm text-fg-2">
            Перетащите EDF-файл сюда или выберите на диске (кнопка ниже или иконка загрузки в шапке
            раздела). Лимит 200 МБ. Запись сохраняется и показывается как есть — обработка
            артефактов и шума запускается отдельными действиями.
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-2">
          <Button
            variant="primary"
            icon={<FileUp className="size-4" />}
            onClick={() => inputRef.current?.click()}
            disabled={uploading !== null}
          >
            Выбрать файл EDF
          </Button>
          <Button
            icon={<FlaskConical className="size-4" />}
            onClick={() => openDemo(channels)}
            title="Синтетический сигнал для отладки вьюера — сервер не нужен"
          >
            Демо-сигнал (синтетика)
          </Button>
        </div>

        {uploading !== null ? (
          <div className="w-full max-w-sm">
            <div className="h-2 overflow-hidden rounded-full bg-bg-3" role="progressbar">
              <div
                className="h-full bg-accent transition-[width]"
                style={{ width: `${Math.round(uploading * 100)}%` }}
              />
            </div>
            <p className="tnum mt-1 text-sm text-fg-2">Загрузка… {Math.round(uploading * 100)}%</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Треки записи: догрузка уровня пирамиды + состояния loading/error/stale. */
function RecordingTracks({
  recording,
  levels,
}: {
  recording: RecordingMeta
  /** Доступные уровни пирамиды (множители зума из `/meta`) */
  levels: number[]
}) {
  const frames = useEdfRecording((state) => state.signalFrames)
  const pending = useEdfRecording((state) => state.signalsPending)
  const signalsError = useEdfRecording((state) => state.signalsError)
  const loadSignals = useEdfRecording((state) => state.loadSignals)
  const layers = useEdfRecording((state) => state.layers)
  // События записи (N2/2.7) — из паспорта: слой живёт до всякой обработки
  const events = useMemo(() => eventMarks(recording.events ?? []), [recording])
  const levelIndex = useEdfParams((state) => state.params.timeLevel)
  const level = resolveSignalLevel(TIME_LEVELS[levelIndex] ?? 1, levels)
  const baseLevel = resolveSignalLevel(levels[0] ?? 1, levels)

  // Уровень ×1 — мгновенный вид «вся сессия»: грузим его сразу, ещё до того,
  // как пользователь начнёт зумить (docs/ui.md §8).
  useEffect(() => {
    void loadSignals(baseLevel)
  }, [loadSignals, baseLevel, recording.recording_id])

  useEffect(() => {
    void loadSignals(level)
  }, [loadSignals, level, recording.recording_id])

  const frame = selectFrame(frames, level)
  const loaded = Boolean(frames[level])

  return (
    <Panel title="Треки записи" className="flex min-h-0 flex-1 flex-col">
      {signalsError && !frame ? (
        <ErrorBlock
          title="Не удалось получить сигналы записи"
          message={signalsError}
          onRetry={() => void loadSignals(level)}
        />
      ) : !frame ? (
        <LoadingBlock label={`Чтение сигналов записи (уровень ×${level})…`} />
      ) : (
        <>
          {signalsError ? (
            <ErrorBlock
              title="Уровень не догрузился"
              message={signalsError}
              onRetry={() => void loadSignals(level)}
            />
          ) : null}
          <TrackStack signal={frame} layers={layers ?? undefined} events={events} />
          <p className="tnum px-2 pb-1 text-xs text-fg-2">
            {pending > 0 && !loaded
              ? `Уровень ×${level} догружается — пока показывается ${frame.level > 0 ? `уровень ×${frame.level}` : 'полный сигнал'}`
              : `Уровень ×${level}: ${frame.times.length} точек на канал, огибающая min/max`}
          </p>
        </>
      )}
    </Panel>
  )
}

export function EdfSection() {
  const recording = useEdfRecording((state) => state.recording)
  const demo = useEdfRecording((state) => state.demo)
  const uploadProgress = useEdfRecording((state) => state.uploadProgress)
  const uploadError = useEdfRecording((state) => state.uploadError)
  const requestFileDialog = useEdfRecording((state) => state.fileDialogRequest)
  const closeDemo = useEdfRecording((state) => state.closeDemo)
  const inputRef = useRef<HTMLInputElement>(null)

  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })

  // Каналы для демо-режима: запись → монтаж из /meta → фикстурный набор
  const demoChannels = recording?.channels ?? meta.data?.standard_channels ?? DEMO_CHANNELS
  // Уровни пирамиды сигналов: источник — /meta, фолбэк — дискретные ×1…×16 UI
  const signalLevels = meta.data?.signal_levels?.length ? meta.data.signal_levels : [...TIME_LEVELS]

  if (demo) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-3">
        <FileDialogInput inputRef={inputRef} request={requestFileDialog} />
        <div className="flex items-center gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          <FlaskConical className="size-4 shrink-0" aria-hidden />
          <span>
            Демо-сигнал (синтетика): вьюер отлаживается без сервера. Для реальной записи загрузите
            EDF — треки придут из её сигналов.
          </span>
          <Button className="ml-auto" icon={<X className="size-4" />} onClick={closeDemo}>
            Закрыть демо
          </Button>
        </div>
        <TrackStack signal={demo} />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3">
      <FileDialogInput inputRef={inputRef} request={requestFileDialog} />
      {uploadError ? <ErrorBlock title="Загрузка не удалась" message={uploadError} /> : null}

      {recording ? (
        <RecordingTracks recording={recording} levels={signalLevels} />
      ) : (
        <Dropzone channels={demoChannels} uploading={uploadProgress} inputRef={inputRef} />
      )}
    </div>
  )
}
