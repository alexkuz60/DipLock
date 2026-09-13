/**
 * Раздел EDF: загрузка записи (drag & drop) и просмотр сырых треков.
 *
 * Обработки здесь нет: загрузка возвращает только паспорт записи
 * (`POST /api/v1/recordings`), поэтому пользователь сначала видит сигнал как он
 * есть и уже по картинке решает, нужна ли обработка артефактов и шума.
 * Вьюер пока работает на демо-сигнале: эндпоинт сигналов записи — срез 2.5.
 *
 * Диалог выбора EDF один на раздел: его открывают и кнопка в зоне загрузки,
 * и иконка «Загрузить EDF» в тулс-хедере (через `fileDialogRequest`).
 */
import { useQuery } from '@tanstack/react-query'
import { FileUp, FlaskConical, X } from 'lucide-react'
import { useEffect, useRef, useState, type DragEvent, type RefObject } from 'react'
import { api } from '@/shared/api/client'
import type { RecordingMeta } from '@/shared/api/types'
import { DEMO_CHANNELS } from '@/shared/lib/demoSignal'
import { acceptEdfFile, useEdfRecording } from '@/shared/state/edfRecording'
import { Button } from '@/shared/ui/Button'
import { cx } from '@/shared/ui/cx'
import { Panel } from '@/shared/ui/Panel'
import { StatusPill } from '@/shared/ui/StatusPill'
import { ErrorBlock, InfoRow } from '@/shared/ui/StateViews'
import { TrackStack } from './viewer/TrackStack'

/** Скрытый input записи: открывается кнопкой тулс-хедера или зоны загрузки. */
function FileDialogInput({
  inputRef,
  request,
}: {
  inputRef: RefObject<HTMLInputElement | null>
  request: number
}) {
  useEffect(() => {
    if (request > 0) inputRef.current?.click()
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

function RecordingCard({ recording, onClose }: { recording: RecordingMeta; onClose: () => void }) {
  return (
    <Panel
      title="Запись"
      hint="Файл на сервере живёт до TTL записей; расчёт не запускался — треки показываются как в файле."
    >
      <div className="grid grid-cols-2 gap-x-6">
        <InfoRow label="Файл" value={recording.filename} mono />
        <InfoRow label="Каналов в файле" value={recording.n_channels} />
        <InfoRow label="Каналы 10-20" value={`${recording.channels.length}`} />
        <InfoRow label="Частота" value={`${recording.sfreq} Гц`} mono />
        <InfoRow label="Длительность" value={`${recording.duration_sec} с`} mono />
        <InfoRow
          label="Единицы"
          value={recording.units_autoscaled ? 'µV (авто-пересчёт)' : (recording.edf_units ?? 'из файла')}
        />
      </div>
      {recording.warnings.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {recording.warnings.map((warning) => (
            <StatusPill key={warning} tone="warn">
              {warning}
            </StatusPill>
          ))}
        </div>
      ) : null}
      <Button className="mt-3" variant="ghost" icon={<X className="size-4" />} onClick={onClose}>
        Закрыть запись
      </Button>
    </Panel>
  )
}

export function EdfSection() {
  const recording = useEdfRecording((state) => state.recording)
  const demo = useEdfRecording((state) => state.demo)
  const uploadProgress = useEdfRecording((state) => state.uploadProgress)
  const uploadError = useEdfRecording((state) => state.uploadError)
  const requestFileDialog = useEdfRecording((state) => state.fileDialogRequest)
  const openDemo = useEdfRecording((state) => state.openDemo)
  const closeDemo = useEdfRecording((state) => state.closeDemo)
  const closeRecording = useEdfRecording((state) => state.closeRecording)
  const inputRef = useRef<HTMLInputElement>(null)

  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })

  // Каналы для демо-режима: запись → монтаж из /meta → фикстурный набор
  const demoChannels = recording?.channels ?? meta.data?.standard_channels ?? DEMO_CHANNELS

  if (demo) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-3">
        <FileDialogInput inputRef={inputRef} request={requestFileDialog} />
        <div className="flex items-center gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          <FlaskConical className="size-4 shrink-0" aria-hidden />
          <span>
            Демо-сигнал (синтетика): вьюер отлаживается без сервера. Сигналы записи появятся после
            эндпоинта сигналов (срез 2.5).
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
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <FileDialogInput inputRef={inputRef} request={requestFileDialog} />
      {uploadError ? <ErrorBlock title="Загрузка не удалась" message={uploadError} /> : null}

      {recording ? (
        <>
          <RecordingCard recording={recording} onClose={closeRecording} />
          <Panel title="Треки записи">
            <p className="text-sm text-fg-2">
              Отрисовка каналов записи появится после эндпоинта сигналов (срез 2.5); вьюер, зум и
              паспорт сессии уже работают в шапке раздела. Пока треки можно посмотреть на
              демо-сигнале:
            </p>
            <Button
              className="mt-2"
              icon={<FlaskConical className="size-4" />}
              onClick={() => openDemo(demoChannels)}
            >
              Открыть демо-треки
            </Button>
          </Panel>
        </>
      ) : (
        <>
          <Dropzone channels={demoChannels} uploading={uploadProgress} inputRef={inputRef} />

        </>
      )}
    </div>
  )
}
