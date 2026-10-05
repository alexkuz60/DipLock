/**
 * Раздел «Нейромузыка» (эксперимент, docs/rules/neuromusic.md).
 *
 * Партитура ЭЭГ: 7 полосовых треков ×128 (7 октав вверх) + мастер-сведение.
 * Фаза 1 — по ТЗ без слайдеров и персиста: кнопка «Создать аудио» →
 * прогресс-бар с шагами пайплайна (поллинг in-memory статуса на сервере,
 * TTL 15 мин) → плеер мастера, соль-прослушивание треков и скачивание
 * WAV/партитуры (sidecar JSON).
 */
import { useCallback, useEffect, useState } from 'react'
import { Music2 } from 'lucide-react'
import { api, ApiError } from '@/shared/api/client'
import type { AudioRenderStatus } from '@/shared/api/types'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { Button } from '@/shared/ui/Button'
import { Placeholder } from '@/shared/ui/Placeholder'
import { StatusPill } from '@/shared/ui/StatusPill'

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

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return 'Неизвестная ошибка'
}

export function NeuromusicSection() {
  const recording = useEdfRecording((state) => state.recording)
  const [renderId, setRenderId] = useState<string | null>(null)
  const [status, setStatus] = useState<AudioRenderStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** Что играет в плеере: мастер или трек полосы. */
  const [selected, setSelected] = useState<string>('master')

  const running = busy || status?.status === 'running'

  const start = useCallback(async () => {
    if (!recording) return
    setBusy(true)
    setError(null)
    setStatus(null)
    setSelected('master')
    try {
      const started = await api.audioRender(recording.recording_id)
      setRenderId(started.render_id)
    } catch (cause) {
      setError(errorText(cause))
      setBusy(false)
    }
  }, [recording])

  // Поллинг статуса рендера: как у задач (jobPolling), но у своего контракта
  // (running/succeeded/failed, без отмены) — отдельный цикл здесь же.
  useEffect(() => {
    if (!renderId || !busy) return
    let cancelled = false
    const tick = async () => {
      try {
        const next = await api.audioRenderStatus(renderId)
        if (cancelled) return
        setStatus(next)
        if (next.status !== 'running') setBusy(false)
      } catch (cause) {
        if (cancelled) return
        setError(errorText(cause))
        setBusy(false)
      }
    }
    void tick()
    const timer = window.setInterval(() => void tick(), 400)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [renderId, busy])

  if (!recording) {
    return (
      <Placeholder
        icon={<Music2 className="size-12" />}
        title="Нейромузыка — ЭЭГ в звук"
        description="Экспериментальный рендер: очищенная запись звучит как партитура оркестра — 7 полосовых треков, поднятых на 7 октав, и мастер-сведение."
      >
        <p className="text-sm text-fg-2">
          Откройте ЭЭГ-запись в разделе «EDF», затем вернитесь сюда и нажмите «Создать аудио».
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
            полос ×128 (7 октав) + мастер, WAV 48 кГц/24 бит.
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
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
          <Button variant="primary" onClick={() => void start()} disabled={running}>
            {running ? 'Рендеринг…' : 'Создать аудио'}
          </Button>
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

      {status?.status === 'succeeded' && renderId && (
        <section aria-label="Прослушивание" className="flex flex-col gap-3">
          <audio
            key={source}
            controls
            preload="none"
            src={source}
            className="w-full"
            data-testid="neuromusic-player"
          />

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
            {tracks.map((band) => (
              <li key={band} className="flex items-center gap-3 px-3 py-2">
                <Button
                  variant="ghost"
                  className={selected === band ? 'text-accent' : undefined}
                  onClick={() => setSelected(band)}
                >
                  {bandLabel(band)}
                </Button>
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
