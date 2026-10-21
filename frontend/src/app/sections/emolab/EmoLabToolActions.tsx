/**
 * Тулс-хедер «ЕмоЛаб» (шаг 1): открытие внешнего аудиотрека и транспорт.
 *
 * * `EmoLabTitleFile` — имя открытого аудиофайла после названия раздела
 *   (слот `titleAfter` каркаса, паттерн «Нейромузыки»);
 * * `EmoLabToolActions` — кнопка «Открыть аудио» (wav/mp3), контролы вида
 *   (зум ×1/×10/×100, таймкод) и транспорт Play/Pause и Stop.
 *
 * Скорость воспроизведения в «ЕмоЛаб» **только ×1** (постановка 20.10.2026) —
 * контрола «Скорость» нет, `rate` движка остаётся дефолтным. Таймкод пишет
 * rAF-цикл трекера через общий `trackerTimeRef` (без ре-рендеров хедера,
 * правило `docs/rules/frontend-perf.md`).
 */
import { useRef } from 'react'
import { FolderOpen, Pause, Play, Square } from 'lucide-react'
import { TIME_ZOOMS, type TimeZoom } from '@/shared/lib/waveformView'
import { useEmoLab } from '@/shared/state/emolab'
import { useNeuromusicPlayer } from '@/shared/state/neuromusicPlayer'
import { IconButton } from '@/shared/ui/IconButton'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { StatusPill } from '@/shared/ui/StatusPill'
import { trackerTimeRef } from '../neuromusic/trackerTimeRef'

/** Имя открытого аудиотрека сразу после названия раздела (без файла — пусто). */
export function EmoLabTitleFile() {
  const filename = useEmoLab((state) => state.filename)
  if (!filename) return null
  return (
    <span
      className="truncate text-base font-medium text-fg-1"
      title={filename}
      data-testid="emolab-title-file"
    >
      {filename}
    </span>
  )
}

export function EmoLabToolActions() {
  const filename = useEmoLab((state) => state.filename)
  const busy = useEmoLab((state) => state.busy)
  const status = useEmoLab((state) => state.status)
  const cached = useEmoLab((state) => state.cached)
  const openFile = useEmoLab((state) => state.openFile)
  const inputRef = useRef<HTMLInputElement>(null)

  const zoom = useNeuromusicPlayer((state) => state.zoom)
  const playing = useNeuromusicPlayer((state) => state.playing)
  const playerReady = useNeuromusicPlayer((state) => state.ready)
  const togglePlay = useNeuromusicPlayer((state) => state.togglePlay)
  const stop = useNeuromusicPlayer((state) => state.stop)

  const succeeded = status?.status === 'succeeded'

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".wav,.mp3,audio/wav,audio/mpeg"
        className="hidden"
        data-testid="emolab-file-input"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Сброс value: тот же файл можно выбрать повторно (change сработает).
          event.target.value = ''
          if (file) void openFile(file)
        }}
      />
      <IconButton
        icon={<FolderOpen className="size-5" />}
        label="Открыть аудио"
        tooltip="Открыть внешний аудиотрек (wav, mp3) для анализа и прослушивания"
        onClick={() => inputRef.current?.click()}
        data-testid="emolab-open"
      />
      {filename && (
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            layout="inline"
            label="Зум"
            value={String(zoom)}
            options={TIME_ZOOMS.map((value) => ({
              value: String(value),
              label: `×${value}`,
              title:
                value === 1
                  ? 'Весь файл целиком'
                  : `Окно 1/${value} файла — детали вокруг позиционера`,
            }))}
            onChange={(value) => useNeuromusicPlayer.getState().setZoom(Number(value) as TimeZoom)}
          />
          <span
            ref={trackerTimeRef}
            data-testid="tracker-time"
            className="text-sm tabular-nums text-fg-2"
          >
            0:00 / 0:00
          </span>
          <IconButton
            icon={
              playing ? (
                <Pause className="size-5" aria-hidden />
              ) : (
                <Play className="size-5" aria-hidden />
              )
            }
            label={playing ? 'Пауза' : 'Слушать'}
            tooltip={
              playing ? 'Пауза' : 'Слушать трекер (волна и позиционер слева направо)'
            }
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
      {(busy || status) && (
        <StatusPill
          tone={succeeded ? 'ok' : status?.status === 'failed' ? 'danger' : 'warn'}
        >
          {succeeded
            ? // cached из ответа POST: файл уже проанализирован — честно
              // показываем, что расчёт не запускался.
              cached
              ? 'Готово (из кэша)'
              : 'Готово'
            : status?.status === 'failed'
              ? 'Ошибка'
              : 'Анализ…'}
        </StatusPill>
      )}
    </>
  )
}