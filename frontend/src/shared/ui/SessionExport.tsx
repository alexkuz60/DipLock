import { useEffect, useRef, useState } from 'react'
import { api, apiErrorText } from '@/shared/api/client'
import type { BundleResult } from '@/shared/api/types'
import {
  cancelRemoteJob,
  createRunToken,
  isCancelled,
  waitForJob,
  type RunToken,
} from '@/shared/lib/jobPolling'
import { Button } from './Button'
import { CancelJobButton } from './CancelJobButton'
import { Panel } from './Panel'
import { SegmentedControl } from './SegmentedControl'
import { StatusPill } from './StatusPill'

/**
 * Панель «Экспорт записи» (N40/4.6): пакет сессии (zip) и CSV таблицы диполей.
 *
 * Пакет — задача `kind=bundle` (правило 2 `docs/rules/api-jobs.md`): запуск
 * кнопкой → общий `waitForJob` → `zip_url` из результата. Формат — параметр
 * сборки: его правка задачу **не** запускает («правка параметра не запускает
 * расчёт» — `docs/rules/frontend-state.md`), но сбрасывает прежний результат —
 * иначе ссылка вела бы на zip старого формата. CSV — синхронная выгрузка
 * готовых строк, ссылка живёт всегда.
 */

type ExportStatus = 'idle' | 'running' | 'done' | 'error'

export type SessionExportProps = {
  /** Запись открыта; null — панель честно говорит, что экспортировать нечего */
  recordingId: string | null
}

export function SessionExport({ recordingId }: SessionExportProps) {
  const [format, setFormat] = useState<'session' | 'bids'>('session')
  const [status, setStatus] = useState<ExportStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState('')
  const [result, setResult] = useState<BundleResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tokenRef = useRef<RunToken>(createRunToken())
  const jobIdRef = useRef<string | null>(null)

  // Смена записи — устаревший запуск не дорисовывает состояние чужой записи
  useEffect(() => {
    tokenRef.current.cancel()
    setStatus('idle')
    setResult(null)
    setError(null)
    jobIdRef.current = null
  }, [recordingId])

  async function startBundle() {
    if (!recordingId) return
    const token = tokenRef.current.next()
    setError(null)
    setResult(null)
    setStatus('running')
    setProgress(0)
    try {
      const form = new FormData()
      form.set('format', format)
      const created = await api.bundle.start(recordingId, form)
      jobIdRef.current = created.job_id
      await waitForJob(
        created.job_id,
        () => tokenRef.current.isCurrent(token),
        (job) => {
          setProgress(job.progress)
          setStage(job.message)
        },
      )
      const bundle = await api.bundle.result(recordingId, created.job_id)
      if (!tokenRef.current.isCurrent(token)) return
      setResult(bundle)
      setStatus('done')
    } catch (err) {
      if (isCancelled(err)) return
      setError(apiErrorText(err))
      setStatus('error')
    }
  }

  function cancelBundle() {
    const jobId = jobIdRef.current
    tokenRef.current.cancel()
    setStatus('idle')
    if (jobId) cancelRemoteJob(jobId, tokenRef.current)
  }

  return (
    <Panel
      title="Экспорт записи"
      hint="Пакет (zip) собирается фоновой задачей: манифест версий, паспорт, параметры и результаты задач; формат BIDS — минимальная структура для передачи в другие инструменты. CSV — таблица диполей всех сессий, скачивается сразу."
    >
      {recordingId ? (
        <>
          <SegmentedControl
            label="Формат пакета"
            value={format}
            options={[
              { value: 'session', label: 'session (EDF + результаты)' },
              { value: 'bids', label: 'bids' },
            ]}
            onChange={(value) => {
              setFormat(value as 'session' | 'bids')
              // Параметр не запускает расчёт, но и не оставляет ссылку
              // на zip прежнего формата
              if (status === 'done') {
                setResult(null)
                setStatus('idle')
              }
            }}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={status === 'running'}
              onClick={() => void startBundle()}
            >
              {status === 'running' ? 'Собираем…' : 'Собрать пакет (zip)'}
            </Button>
            <a
              className="text-sm text-accent underline-offset-2 hover:underline"
              href={api.dipolesCsv(recordingId)}
              download
              data-testid="dipoles-csv-link"
            >
              Скачать таблицу диполей (CSV)
            </a>
          </div>
          {status === 'running' ? (
            <>
              <StatusPill tone="accent">
                {Math.round(progress * 100)} %{stage ? ` — ${stage}` : ''}
              </StatusPill>
              <div className="mt-2">
                <CancelJobButton onCancel={cancelBundle} />
              </div>
            </>
          ) : null}
          {error ? (
            <p className="mt-2 text-sm text-danger" data-testid="bundle-error">
              {error}
            </p>
          ) : null}
          {status === 'done' && result ? (
            <div className="mt-3" data-testid="bundle-result">
              <StatusPill tone="ok">
                Готово: {(result.size_bytes / (1024 * 1024)).toFixed(1)} МБ, файлов{' '}
                {result.files.length}
              </StatusPill>
              <div className="mt-2 flex flex-wrap gap-2">
                <a
                  className="rounded-sm bg-accent px-3 py-1.5 text-sm font-medium text-bg-0 no-underline hover:brightness-110"
                  href={result.zip_url ?? '#'}
                  download
                >
                  Скачать zip
                </a>
                <span className="self-center text-xs text-fg-2">
                  формат {result.format}, отпечаток {result.sig}
                </span>
              </div>
              {(result.warnings ?? []).map((text) => (
                <p key={text} className="mt-1 text-xs text-warn">
                  {text}
                </p>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-fg-2">Запись не загружена — экспортировать пока нечего.</p>
      )}
    </Panel>
  )
}
