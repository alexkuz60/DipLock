/**
 * Пространственный плеер «Нейромузыки»: 7 стемов через Tone-цепочку
 * `Player → StereoWidener → Panner3D → dry/wet Convolver → master`
 * (docs/rules/spatial-audio.md, п.1).
 *
 * Показывается вместо `<audio>`, когда в панели включён «3D-режим» и рендер
 * готов. Параметры читаются из стора и применяются к живому графу
 * мгновенно — правка не запускает ни POST, ни пересчёт (правило UI).
 * Загрузка буферов — показывает «Загрузка…», ошибка — текст для пользователя.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { api } from '@/shared/api/client'
import { SpatialAudioPlayer } from '@/shared/lib/spatialPlayer'
import { useNeuromusic } from '@/shared/state/neuromusic'
import { Button } from '@/shared/ui/Button'

export type NeuromusicSpatialPlayerProps = {
  renderId: string
  /** Готовые треки (`status.tracks`), порядок — как в партитуре */
  tracks: string[]
}

/** ЧЧ:ММ для метки времени плеера. */
function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

export function NeuromusicSpatialPlayer({ renderId, tracks }: NeuromusicSpatialPlayerProps) {
  const widthPct = useNeuromusic((state) => state.spatialWidthPct)
  const spreadPct = useNeuromusic((state) => state.spatialSpreadPct)
  const wetPct = useNeuromusic((state) => state.spatialWetPct)
  const irPreset = useNeuromusic((state) => state.spatialIr)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)

  const playerRef = useRef<SpatialAudioPlayer | null>(null)

  // Построение графа: один раз на рендер; при смене записи/размонтировании — dispose.
  // irPreset сознательно вне зависимостей: смена помещения подхватывается
  // отдельным эффектом ниже (без перезагрузки стемов).
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    SpatialAudioPlayer.load({
      trackUrls: tracks.map((band) => api.audioTrackUrl(renderId, band)),
      irUrl: api.audioIrUrl(useNeuromusic.getState().spatialIr),
      widthPct: useNeuromusic.getState().spatialWidthPct,
      spreadPct: useNeuromusic.getState().spatialSpreadPct,
      wetPct: useNeuromusic.getState().spatialWetPct,
    })
      .then((player) => {
        if (cancelled) {
          player.dispose()
          return
        }
        playerRef.current = player
        setDuration(player.duration)
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setLoadError(cause instanceof Error ? cause.message : 'Не удалось построить 3D-плеер')
        setLoading(false)
      })
    return () => {
      cancelled = true
      playerRef.current?.dispose()
      playerRef.current = null
    }
  }, [renderId, tracks])

  // Real-time параметры: правка в панели применяется к живому графу, без сетевых
  // запросов (кроме смены IR — это GET готового ассета, не расчёт).
  useEffect(() => {
    playerRef.current?.setWidth(widthPct)
  }, [widthPct])
  useEffect(() => {
    playerRef.current?.setSpread(spreadPct)
  }, [spreadPct])
  useEffect(() => {
    playerRef.current?.setWet(wetPct)
  }, [wetPct])
  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    void player.setIrUrl(api.audioIrUrl(irPreset)).catch((cause: unknown) => {
      setLoadError(cause instanceof Error ? cause.message : 'Не удалось загрузить IR')
    })
    // loading — поймать смену пресета, случившуюся пока граф ещё строился.
  }, [irPreset, loading])

  // Позиция проигрывания: опрос 200 мс + сброс к началу на конце трека.
  useEffect(() => {
    if (!playing) return
    const timer = window.setInterval(() => {
      const player = playerRef.current
      if (!player) return
      if (player.playing && player.position >= player.duration - 0.05) {
        player.finish()
        setPlaying(false)
        setPosition(0)
        return
      }
      setPosition(player.position)
    }, 200)
    return () => window.clearInterval(timer)
  }, [playing])

  const togglePlay = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    if (player.playing) {
      player.pause()
      setPosition(player.position)
      setPlaying(false)
    } else {
      void player.play().then(() => setPlaying(true))
    }
  }, [])

  const seekTo = useCallback((seconds: number) => {
    const player = playerRef.current
    if (!player) return
    void player.seek(seconds).then(() => setPosition(player.position))
  }, [])

  if (loadError) {
    return (
      <p
        role="alert"
        className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
      >
        3D-плеер: {loadError}
      </p>
    )
  }

  return (
    <section
      aria-label="Пространственный плеер"
      className="flex flex-col gap-3 rounded-xl border border-border bg-bg-2 p-4"
    >
      <p className="text-sm text-fg-2">
        3D-режим: 7 треков на дуге перед слушателем (слева δ, справа γ-high), HRTF-панорамирование
        и свёрточная реверберация — параметры в панели «Пространство» применяются на лету.
      </p>

      {loading ? (
        <p className="text-sm text-fg-1" data-testid="spatial-loading">
          Загрузка треков и IR…
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <Button
            onClick={togglePlay}
            aria-label={playing ? 'Пауза' : 'Слушать'}
            data-testid="spatial-toggle"
          >
            {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
            {playing ? 'Пауза' : 'Слушать'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => seekTo(0)}
            aria-label="В начало"
            disabled={position === 0}
          >
            <RotateCcw className="size-4" aria-hidden />
          </Button>
          <input
            type="range"
            min={0}
            max={Math.max(duration, 0.1)}
            step={0.1}
            value={Math.min(position, duration)}
            onChange={(event) => seekTo(Number(event.target.value))}
            aria-label="Позиция воспроизведения"
            className="flex-1"
          />
          <span className="text-xs tabular-nums text-fg-2" data-testid="spatial-time">
            {formatTime(position)} / {formatTime(duration)}
          </span>
        </div>
      )}
    </section>
  )
}

