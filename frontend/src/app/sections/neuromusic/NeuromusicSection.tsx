/**
 * Раздел «Нейромузыка» (эксперимент, docs/rules/neuromusic.md).
 *
 * Рабочая область отдана графике: подсказка без записи, статус/прогресс
 * рендера, трекер-плеер (`WaveTracker`: линейка времени + волна-бабочка +
 * позиционер) и под ним секция **«Визуализация»** (2 колонки: силуэт
 * головы `BrainRoomView`, перенесённый из «Опций» правого сайдбара, и
 * радиальный график `RadialChart`; без шапок/подписей, вписывается по
 * высоте рабочей области без прокрутки; видна только вместе с плеером —
 * после успешного рендера). Транспорт Play/Pause и Stop — кнопки хедера
 * раздела, ссылки «Скачать…» — секция «Файлы» правого сайдбара
 * (`NeuromusicPanel`); параметры рендера — секция «Параметры рендера»
 * того же сайдбара (правка параметра рендер не запускает).
 *
 * Состояние: сторы `shared/state/neuromusic.ts` (рендер, поллинг) и
 * `shared/state/neuromusicPlayer.ts` (транспорт/вид плеера — их делят хедер
 * и трекер). Поллинг живёт в сторе рендера и переживает уход из раздела;
 * результат принадлежит записи — при закрытии/смене записи сбрасывается здесь
 * (паттерн `summaryReport`).
 */
import { useEffect, useMemo, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Music2, Pause, Play, Square } from 'lucide-react'
import { api } from '@/shared/api/client'
import type { AudioRenderVariant } from '@/shared/api/types'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { useNeuromusic } from '@/shared/state/neuromusic'
import { useNeuromusicPlayer } from '@/shared/state/neuromusicPlayer'
import { IconButton } from '@/shared/ui/IconButton'
import { Placeholder } from '@/shared/ui/Placeholder'
import { StatusPill } from '@/shared/ui/StatusPill'
import { BrainRoomView } from './BrainRoomView'
import { EmoCounters } from './EmoCounters'
import { RadialChart } from './RadialChart'
import { MONTAGE_ROW_IDS } from './rowMeta'
import { TrackerControls } from './TrackerControls'
import { WaveTracker } from './WaveTracker'

export function NeuromusicSection() {
  const recording = useEdfRecording((state) => state.recording)
  const renderId = useNeuromusic((state) => state.renderId)
  const status = useNeuromusic((state) => state.status)
  const busy = useNeuromusic((state) => state.busy)
  const cached = useNeuromusic((state) => state.cached)
  const error = useNeuromusic((state) => state.error)
  /** Для силуэта «Визуализации»: вариант/разброс сцены — из того же стора. */
  const variant = useNeuromusic((state) => state.variant)
  const spatialSpreadPct = useNeuromusic((state) => state.spatialSpreadPct)

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

  // Кадры радара «Эмо» (08.10.2026): один GET на готовый рендер — ключ по
  // render_id, данные неизменяемы (staleTime ∞), ошибки не повторяем:
  // при недоступности график остаётся на фоллбэк-рандомизаторе. `renderId`
  // в queryFn не null только при включённом запросе (`enabled` ниже).
  const emoQuery = useQuery({
    queryKey: ['audio-emo', renderId],
    queryFn: ({ signal }) => api.audioEmo(renderId ?? '', signal),
    enabled: Boolean(succeeded && renderId),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })

  // Геометрия силуэта «Визуализации» (перенесена из «Опций» 07.10.2026):
  // играющий рендер (status) важнее выбранного варианта — до рендера
  // секции нет, но логика осталась прежней (панель «Пространства»).
  const sceneVariant: AudioRenderVariant =
    (status?.variant ?? variant) === 'montage' ? 'montage' : 'express'
  const sceneRows: readonly string[] = status
    ? status.variant === 'montage'
      ? (status.rows ?? [])
      : []
    : variant === 'montage'
      ? MONTAGE_ROW_IDS
      : []

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
        <section aria-label="Прослушивание" className="flex shrink-0 flex-col gap-3">
          <WaveTracker
            renderId={renderId}
            tracks={tracks}
            timeRef={timeRef}
            emo={emoQuery.data ?? null}
          />
        </section>
      )}

      {/* Первая нижняя область визуализации под трекером (задел 06.10.2026,
          спецификация владельца 07.10.2026): 2 колонки — силуэт головы
          (перенесён из «Опций» правого сайдбара) и радиальный график.
          Без шапок и подписей (экономия высоты, правка 07.10.2026): секция
          растягивается на весь остаток рабочей области (flex-1), картинки
          вписываются по высоте ячеек — под трекером прокрутки нет. Видна
          только вместе с плеером — после успешного рендера. */}
      {succeeded && renderId && (
        <section
          aria-label="Визуализация"
          className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-bg-2 p-2"
          data-testid="neuromusic-visualization"
        >
          <div
            className="grid min-h-0 flex-1 grid-cols-1 grid-rows-2 gap-3 md:grid-cols-2 md:grid-rows-1"
            data-testid="visualization-columns"
          >
            {/* Колонка 1: голова вид сверху — та же геометрия сцены, что
                играет/будет посчитано (вариант/разброс — из стора). */}
            <div className="h-full min-h-0 overflow-hidden">
              <BrainRoomView
                variant={sceneVariant}
                rows={sceneRows}
                bands={tracks.length}
                spreadPct={spatialSpreadPct}
              />
            </div>
            {/* Колонка 2: радиальный график — 7 сегментов от π/2 + π/7
                против часовой, оси X/Y, сетка 25/50/75 %, круг-граница;
                полигон анимируется по кадрам «Эмо» (или фоллбэк-рандом).
                Справа-сверху от графика — счётчики «Аккорд»/«Темп»
                (09.10.2026): пиули прибиты к правому краю секции ЭМО-графика,
                текст — размера названия раздела в шапке (НЕ в подзаголовке
                секции — правка владельца). */}
            <div className="flex h-full min-h-0">
              <div className="min-w-0 flex-1">
                <RadialChart emo={emoQuery.data ?? null} />
              </div>
              <EmoCounters emo={emoQuery.data ?? null} />
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
