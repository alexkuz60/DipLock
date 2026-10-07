/**
 * Раздел «Нейромузыка» (эксперимент, docs/rules/neuromusic.md).
 *
 * Рабочая область отдана графике: подсказка без записи, статус/прогресс
 * рендера и трекер-плеер (`WaveTracker`: линейка времени + волна-бабочка +
 * позиционер). Транспорт Play/Pause и Stop — кнопки хедера раздела, ссылки
 * «Скачать…» — секция «Файлы» правого сайдбара (`NeuromusicPanel`); параметры
 * рендера — секция «Параметры рендера» того же сайдбара (правка параметра
 * рендер не запускает).
 *
 * Состояние: сторы `shared/state/neuromusic.ts` (рендер, поллинг) и
 * `shared/state/neuromusicPlayer.ts` (транспорт/вид плеера — их делят хедер
 * и трекер). Поллинг живёт в сторе рендера и переживает уход из раздела;
 * результат принадлежит записи — при закрытии/смене записи сбрасывается здесь
 * (паттерн `summaryReport`).
 */
import { useEffect, useMemo, useRef } from 'react'
import { Music2, Pause, Play, Square } from 'lucide-react'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { useNeuromusic } from '@/shared/state/neuromusic'
import { useNeuromusicPlayer } from '@/shared/state/neuromusicPlayer'
import { IconButton } from '@/shared/ui/IconButton'
import { Placeholder } from '@/shared/ui/Placeholder'
import { StatusPill } from '@/shared/ui/StatusPill'
import { TrackerControls } from './TrackerControls'
import { WaveTracker } from './WaveTracker'

export function NeuromusicSection() {
  const recording = useEdfRecording((state) => state.recording)
  const renderId = useNeuromusic((state) => state.renderId)
  const status = useNeuromusic((state) => state.status)
  const busy = useNeuromusic((state) => state.busy)
  const error = useNeuromusic((state) => state.error)

  /** Транспорт хедера живёт в сторе плеера — с ним же делит его трекер. */
  const playing = useNeuromusicPlayer((state) => state.playing)
  const playerReady = useNeuromusicPlayer((state) => state.ready)
  const togglePlay = useNeuromusicPlayer((state) => state.togglePlay)
  const stop = useNeuromusicPlayer((state) => state.stop)
  /** Таймкод хедера: пишет paint трекера (rAF, без ре-рендеров хедера). */
  const timeRef = useRef<HTMLSpanElement>(null)

  const running = busy || status?.status === 'running'
  const succeeded = status?.status === 'succeeded'
  const tracks = useMemo(() => status?.tracks ?? [], [status])

  // Новый запуск кнопкой в хедере (busy=true): плеер снова с мастера —
  // как и раньше при нажатии «Создать аудио» внутри секции.
  useEffect(() => {
    if (busy) useNeuromusicPlayer.getState().reset()
  }, [busy])

  // Результат принадлежит записи: закрытие/смена записи убирает чужой рендер
  // и сбрасывает источник/транспорт плеера.
  const recordingId = recording?.recording_id ?? null
  useEffect(() => {
    const state = useNeuromusic.getState()
    if (state.renderId && state.renderRecordingId !== recordingId) state.reset()
    useNeuromusicPlayer.getState().reset()
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <header className="flex flex-wrap items-center gap-3">
        <Music2 className="size-6 text-accent" aria-hidden />
        {/* Заголовок хедера — имя ЭЭГ-файла (прежняя строка «Эксперимент: …»
            сокращена по приёмке 07.10.2026). */}
        <h2 className="text-lg font-medium text-fg-1">{recording.filename}</h2>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {succeeded && renderId && (
            <>
              <TrackerControls tracks={tracks} timeRef={timeRef} />
              <IconButton
                icon={
                  playing ? (
                    <Pause className="size-5" aria-hidden />
                  ) : (
                    <Play className="size-5" aria-hidden />
                  )
                }
                label={playing ? 'Пауза' : 'Слушать'}
                tooltip={playing ? 'Пауза' : 'Слушать трекер (волна и позиционер слева направо)'}
                disabled={!playerReady}
                onClick={() => void togglePlay()}
                data-testid="transport-play"
              />
              <IconButton
                icon={<Square className="size-4" aria-hidden />}
                label="Стоп"
                tooltip="Стоп: остановить и вернуть позиционер в начало"
                disabled={!playerReady}
                onClick={() => void stop()}
                data-testid="transport-stop"
              />
            </>
          )}
          {status && (
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
          )}
        </div>
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

      {succeeded && renderId && (
        <section aria-label="Прослушивание" className="flex flex-col gap-3">
          <WaveTracker renderId={renderId} tracks={tracks} timeRef={timeRef} />
        </section>
      )}
    </div>
  )
}
