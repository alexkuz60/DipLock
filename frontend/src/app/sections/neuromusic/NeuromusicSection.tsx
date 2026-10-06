/**
 * Раздел «Нейромузыка» (эксперимент, docs/rules/neuromusic.md).
 *
 * Рабочая область: подсказка без записи, статус и прогресс рендера, плеер
 * мастера, соль-прослушивание треков и скачивание WAV/партитуры (sidecar JSON).
 * Кнопка «Создать аудио» — иконка тулс-хедера (`NeuromusicToolActions`),
 * параметры — секция «Параметры рендера» правого сайдбара (`NeuromusicPanel`):
 * общее состояние — стор `shared/state/neuromusic.ts`, правка параметра рендер
 * не запускает. Поллинг статуса живёт в сторе (у рендера свой контракт
 * running/succeeded/failed, in-memory TTL 15 мин) и переживает уход из раздела.
 */
import { useEffect, useState } from 'react'
import { Music2 } from 'lucide-react'
import { api } from '@/shared/api/client'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { useNeuromusic } from '@/shared/state/neuromusic'
import { Button } from '@/shared/ui/Button'
import { Placeholder } from '@/shared/ui/Placeholder'
import { StatusPill } from '@/shared/ui/StatusPill'
import { NeuromusicSpatialPlayer } from './NeuromusicSpatialPlayer'

/**
 * Стиль ссылок-кнопок («Скачать…»): тот же набор, что ``Button variant="secondary"`` —
 * для ``<a download>`` нужен именно тег ссылки, а не кнопка.
 */
const LINK_BUTTON_CLASS =
  'inline-flex items-center gap-2 rounded-lg border border-border bg-bg-2 px-4 py-2 ' +
  'text-base font-medium text-fg-0 transition-colors hover:bg-bg-3'

/** Человекочитаемые имена полос-«инструментов» (ключи freq_bands). */
const BAND_LABELS: Record<string, string> = {
  delta: 'δ — дельта',
  delta_theta: 'δ/θ — дельта-тета',
  theta: 'θ — тета',
  alpha: 'α — альфа',
  beta: 'β — бета',
  gamma: 'γ — гамма',
  high_gamma: 'γ-high — высокая гамма',
}

const bandLabel = (band: string): string => BAND_LABELS[band] ?? band

export function NeuromusicSection() {
  const recording = useEdfRecording((state) => state.recording)
  const renderId = useNeuromusic((state) => state.renderId)
  const status = useNeuromusic((state) => state.status)
  const busy = useNeuromusic((state) => state.busy)
  const error = useNeuromusic((state) => state.error)
  const octaveShift = useNeuromusic((state) => state.octaveShift)
  /** 3D-режим: вместо `<audio>` — Tone-цепочка (spatial-audio, п.1). */
  const spatialEnabled = useNeuromusic((state) => state.spatialEnabled)
  /** Что играет в плеере: мастер или трек полосы. */
  const [selected, setSelected] = useState<string>('master')

  const running = busy || status?.status === 'running'

  // Новый запуск кнопкой в хедере (busy=true): плеер снова с мастера —
  // как и раньше при нажатии «Создать аудио» внутри секции.
  useEffect(() => {
    if (busy) setSelected('master')
  }, [busy])

  // Результат принадлежит записи: закрытие/смена записи убирает чужой рендер
  // (паттерн `summaryReport`: сброс результата + глушение поллинга токеном).
  const recordingId = recording?.recording_id ?? null
  useEffect(() => {
    const state = useNeuromusic.getState()
    if (state.renderId && state.renderRecordingId !== recordingId) state.reset()
  }, [recordingId])

  if (!recording) {
    return (
      <Placeholder
        icon={<Music2 className="size-12" />}
        title="Нейромузыка — ЭЭГ в звук"
        description="Экспериментальный рендер: очищенная запись звучит как партитура оркестра — 7 полосовых треков, поднятых на 7 октав, и мастер-сведение."
      >
        <p className="text-sm text-fg-2">
          Откройте ЭЭГ-запись в разделе «EDF», затем вернитесь сюда и нажмите «Создать аудио»
          (иконка в шапке раздела; параметры — в панели «Опции раздела» справа).
        </p>
      </Placeholder>
    )
  }

  const tracks = status?.tracks ?? []
  const isMaster = selected === 'master' || !tracks.includes(selected)
  const source = isMaster
    ? api.audioMasterUrl(renderId ?? '')
    : api.audioTrackUrl(renderId ?? '', selected)
  const downloadName = isMaster
    ? `neuromusic-${renderId ?? 'master'}.wav`
    : `neuromusic-${renderId ?? ''}-${selected}.wav`

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <header className="flex flex-wrap items-center gap-3">
        <Music2 className="size-6 text-accent" aria-hidden />
        <div>
          <h2 className="text-lg font-medium text-fg-1">Нейромузыка — ЭЭГ в звук</h2>
          <p className="text-sm text-fg-2">
            Эксперимент: запись <span className="text-fg-1">{recording.filename}</span> → 7 треков
            полос ×{2 ** octaveShift} ({octaveShift} октав) + мастер, WAV 48 кГц/24 бит.
          </p>
        </div>
        {status && (
          <div className="ml-auto">
            <StatusPill
              tone={
                status.status === 'succeeded' ? 'ok' : status.status === 'failed' ? 'danger' : 'warn'
              }
            >
              {status.status === 'succeeded'
                ? 'Готово'
                : status.status === 'failed'
                  ? 'Ошибка'
                  : 'Рендер…'}
            </StatusPill>
          </div>
        )}
      </header>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {running && status && (
        <section
          aria-label="Прогресс рендера"
          className="flex flex-col items-center gap-2 rounded-xl border border-border bg-bg-2 p-6 text-center"
        >
          <p className="text-sm text-fg-1">{status.stage}</p>
          <div
            role="progressbar"
            aria-label="Прогресс рендера партитуры"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(status.pct * 100)}
            className="h-2 w-full max-w-xl overflow-hidden rounded-full bg-bg-3"
          >
            <span
              className="block h-full rounded-full bg-accent transition-[width]"
              style={{ width: `${Math.round(status.pct * 100)}%` }}
            />
          </div>
          <p className="text-xs text-fg-2">{status.message}</p>
        </section>
      )}

      {status?.status === 'failed' && (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          Рендер не удался: {status.error ?? 'причина неизвестна'}
        </p>
      )}

      {status?.status === 'succeeded' && renderId && (
        <section aria-label="Прослушивание" className="flex flex-col gap-3">
          {spatialEnabled ? (
            <NeuromusicSpatialPlayer renderId={renderId} tracks={tracks} />
          ) : (
            <audio
              key={source}
              controls
              preload="none"
              src={source}
              className="w-full"
              data-testid="neuromusic-player"
            />
          )}

          <div className="flex flex-wrap gap-2">
            <a className={LINK_BUTTON_CLASS} href={source} download={downloadName}>
              Скачать {isMaster ? 'мастер' : `трек «${bandLabel(selected)}»`}
            </a>
            <a
              className={LINK_BUTTON_CLASS}
              href={api.audioSidecarUrl(renderId)}
              download={`neuromusic-${renderId}-sidecar.json`}
            >
              Скачать партитуру (.json)
            </a>
          </div>

          <ul className="divide-y divide-border rounded-xl border border-border">
            {!spatialEnabled && (
              <li className="flex items-center gap-3 px-3 py-2">
                <Button
                  variant="ghost"
                  className={selected === 'master' ? 'text-accent' : undefined}
                  onClick={() => setSelected('master')}
                >
                  Мастер — партитура целиком
                </Button>
                <span className="ml-auto text-xs text-fg-2">все 7 инструментов</span>
              </li>
            )}
            {tracks.map((band) => (
              <li key={band} className="flex items-center gap-3 px-3 py-2">
                {/* Соло-прослушивание — только в обычном режиме: в 3D все семь
                    треков звучат разом через Tone-цепочку. */}
                {spatialEnabled ? (
                  <span className="text-sm text-fg-1">{bandLabel(band)}</span>
                ) : (
                  <Button
                    variant="ghost"
                    className={selected === band ? 'text-accent' : undefined}
                    onClick={() => setSelected(band)}
                  >
                    {bandLabel(band)}
                  </Button>
                )}
                <a
                  className="ml-auto text-xs text-accent underline-offset-2 hover:underline"
                  href={api.audioTrackUrl(renderId, band)}
                  download={`neuromusic-${renderId}-${band}.wav`}
                >
                  Скачать .wav
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
