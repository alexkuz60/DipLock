/**
 * Тулс-хедер «Нейромузыки» в одну строку (экономия высоты, правка 10.10.2026):
 *
 * * `NeuromusicTitleIcon` — иконка ноты **перед** названием раздела
 *   (слот `titleBefore` каркаса);
 * * `NeuromusicTitleFile` — имя открытого ЭЭГ-файла **после** названия
 *   (слот `titleAfter`);
 * * `NeuromusicToolActions` — кнопка «Создать аудио», **после неё** контролы
 *   управления готового рендера (`TrackerControls` + Play/Pause и Stop) и
 *   пилюля статуса (прежняя строка рабочей области с иконкой/файлом/контролами
 *   удалена целиком).
 *
 * Параметры рендера живут в правом сайдбаре («Опции раздела»), прогресс и
 * плеер — в рабочей области: кнопка только стартует стор
 * (`useNeuromusic.start()` — запись и параметры он читает сам). Правка
 * параметра рендер не запускает (правило UI), без открытой записи кнопка
 * выключена с объяснением.
 */
import { useMemo } from 'react'
import { AudioLines, Music2, Pause, Play, Square } from 'lucide-react'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { useNeuromusic } from '@/shared/state/neuromusic'
import { useNeuromusicPlayer } from '@/shared/state/neuromusicPlayer'
import { IconButton } from '@/shared/ui/IconButton'
import { StatusPill } from '@/shared/ui/StatusPill'
import { TrackerControls } from './TrackerControls'

/** Иконка ноты перед названием раздела в тулс-хедере. */
export function NeuromusicTitleIcon() {
  return <Music2 className="size-6 shrink-0 text-accent" aria-hidden />
}

/** Имя открытого ЭЭГ-файла сразу после названия раздела (без записи — пусто). */
export function NeuromusicTitleFile() {
  const recording = useEdfRecording((state) => state.recording)
  if (!recording) return null
  return (
    <span
      className="truncate text-base font-medium text-fg-1"
      title={recording.filename}
      data-testid="neuromusic-title-file"
    >
      {recording.filename}
    </span>
  )
}

export function NeuromusicToolActions() {
  const recording = useEdfRecording((state) => state.recording)
  const busy = useNeuromusic((state) => state.busy)
  const status = useNeuromusic((state) => state.status)
  const cached = useNeuromusic((state) => state.cached)
  const renderId = useNeuromusic((state) => state.renderId)
  const start = useNeuromusic((state) => state.start)

  /** Транспорт и контролы — только у готового рендера (как в старом хедере). */
  const playing = useNeuromusicPlayer((state) => state.playing)
  const playerReady = useNeuromusicPlayer((state) => state.ready)
  const togglePlay = useNeuromusicPlayer((state) => state.togglePlay)
  const stop = useNeuromusicPlayer((state) => state.stop)

  const running = busy || status?.status === 'running'
  const succeeded = status?.status === 'succeeded'
  const tracks = useMemo(() => status?.tracks ?? [], [status])

  return (
    <>
      <IconButton
        icon={<AudioLines className="size-5" />}
        label="Создать аудио"
        tooltip={
          !recording
            ? 'Создать аудио: сначала откройте ЭЭГ-запись в разделе EDF'
            : running
              ? 'Идёт рендер партитуры…'
              : 'Создать аудио: рендер партитуры ЭЭГ → стерео (7 треков ×128 + мастер)'
        }
        disabled={!recording || running}
        onClick={() => void start()}
      />
      {succeeded && renderId && (
        <div className="flex flex-wrap items-center gap-2">
          <TrackerControls tracks={tracks} />
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
        </div>
      )}
      {status && (
        <StatusPill
          tone={status.status === 'succeeded' ? 'ok' : status.status === 'failed' ? 'danger' : 'warn'}
        >
          {status.status === 'succeeded'
            ? // cached из ответа POST: те же параметры уже считались —
              // честно показываем, что конвейер не запускался.
              cached
              ? 'Готово (из кэша)'
              : 'Готово'
            : status.status === 'failed'
              ? 'Ошибка'
              : 'Рендер…'}
        </StatusPill>
      )}
    </>
  )
}
