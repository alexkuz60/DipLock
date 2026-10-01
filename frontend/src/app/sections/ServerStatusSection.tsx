/**
 * Состояние сервера: готовность компонентов (MNE, БД, fsaverage, transform, BEM),
 * версии библиотек, пути данных и активные параметры расчёта.
 *
 * Поллинг — 5 с и только пока открыта вкладка (react-query не опрашивает сервер
 * в скрытой вкладке), плюс кнопка «Проверить сейчас». Кнопка «Перезапустить
 * бэкенд» (202 → exec через ~0.5 с) живёт в блоке «API и UI»: во время
 * перезапуска поллинг ускоряется до 1.5 с, а раздел считает его завершённым,
 * когда `code.server_started_at` в /init-status разошёлся с зафиксированным
 * перед перезапуском значением.
 */
import { useQuery } from '@tanstack/react-query'
import { RefreshCw, RotateCcw } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { api, apiErrorText } from '@/shared/api/client'
import { CHECK_TITLES, type CheckStatus } from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { cx } from '@/shared/ui/cx'
import { Panel } from '@/shared/ui/Panel'
import { ErrorBlock, InfoRow, LoadingBlock } from '@/shared/ui/StateViews'

const CHECK_STYLE: Record<CheckStatus, { dot: string; text: string; label: string }> = {
  ready: { dot: 'bg-ok', text: 'text-fg-0', label: 'готово' },
  pending: { dot: 'bg-fg-2', text: 'text-fg-1', label: 'ожидание' },
  loading: { dot: 'bg-accent', text: 'text-fg-1', label: 'загрузка' },
  error: { dot: 'bg-danger', text: 'text-fg-0', label: 'ошибка' },
  unknown: { dot: 'bg-fg-2', text: 'text-fg-2', label: 'неизвестно' },
}

/** Фазы кнопки перезапуска: подтверждение → ожидание нового процесса → успех. */
type RestartPhase = 'idle' | 'confirm' | 'restarting' | 'done'

/** Сколько ждать подъёма нового процесса, прежде чем сдаться (мс). */
const RESTART_TIMEOUT_MS = 60_000

function Column({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 flex-1 space-y-3">
      <h2 className="text-sm font-semibold tracking-wide text-fg-2 uppercase">{title}</h2>
      {children}
    </div>
  )
}

export function ServerStatusSection() {
  /** Фаза перезапуска бэкенда (см. заголовок файла). */
  const [phase, setPhase] = useState<RestartPhase>('idle')
  /** `server_started_at` на момент клика — по нему узнаём новый процесс. */
  const [startedAtBefore, setStartedAtBefore] = useState<string | null>(null)
  /** Число активных задач для текста подтверждения (null — ещё не спрошено). */
  const [busyJobs, setBusyJobs] = useState<number | null>(null)
  /** Текст отказа 409 (dev-режим / не лаунчер / идут задачи). */
  const [restartError, setRestartError] = useState<string | null>(null)

  const restarting = phase === 'restarting'
  const init = useQuery({
    queryKey: ['initStatus'],
    queryFn: ({ signal }) => api.initStatus(signal),
    staleTime: 0,
    // На время перезапуска опрашиваем чаще: процесс поднимается секунды
    refetchInterval: restarting ? 1500 : 5000,
    retry: false,
  })
  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })

  // Новый процесс поднялся: server_started_at разошёлся с зафиксированным.
  useEffect(() => {
    if (phase !== 'restarting' || !startedAtBefore) return
    const current = init.data?.code.server_started_at
    if (current && current !== startedAtBefore) setPhase('done')
  }, [phase, startedAtBefore, init.data])

  // Сервер не поднялся за отведённое время — честно сообщаем, а не крутим вечно.
  useEffect(() => {
    if (phase !== 'restarting') return
    const timer = setTimeout(() => {
      setPhase('idle')
      setRestartError(
        'Сервер не поднялся за 60 с — проверьте data/logs/server.log и ./start.sh status',
      )
    }, RESTART_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [phase])

  /** Первый клик: показать подтверждение с числом активных задач. */
  const askConfirm = () => {
    setRestartError(null)
    setBusyJobs(null)
    setPhase('confirm')
    void api
      .jobs(200)
      .then((jobs) =>
        setBusyJobs(
          jobs.filter((job) => job.status === 'queued' || job.status === 'running').length,
        ),
      )
      .catch(() => setBusyJobs(null)) // список задач не обязателен для подтверждения
  }

  /** Подтверждение: 202 → фиксируем метку процесса и ждём новый. */
  const doRestart = () => {
    const before = init.data?.code.server_started_at ?? null
    void api
      .serverRestart()
      .then(() => {
        setStartedAtBefore(before)
        setRestartError(null)
        setPhase('restarting')
      })
      .catch((error: unknown) => setRestartError(apiErrorText(error)))
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">Готовность компонентов</h2>
        <Button
          className="ml-auto"
          icon={<RefreshCw className={cx('size-4', init.isFetching && 'animate-spin')} />}
          onClick={() => {
            void init.refetch()
            void meta.refetch()
          }}
        >
          Проверить сейчас
        </Button>
        <span className="text-sm text-fg-2">
          {init.data?.status === 'ready' ? 'всё готово' : 'требуется внимание'}
        </span>
      </div>

      {init.isPending ? <LoadingBlock label="Опрос сервера…" /> : null}
      {/* Ошибки опроса во время перезапуска ожидаемы — сервер поднимается */}
      {init.isError && !restarting ? (
        <ErrorBlock
          title="Сервер не отвечает на /init-status"
          message={apiErrorText(init.error)}
          onRetry={() => void init.refetch()}
        />
      ) : null}

      {init.data ? (
        <div className="grid grid-cols-2 gap-4">
          <Column title="Проверки">
            <Panel title="Компоненты">
              {Object.entries(init.data.checks).map(([key, status]) => {
                const style = CHECK_STYLE[status] ?? CHECK_STYLE.unknown
                return (
                  <div key={key} className="ui-list-row flex items-center gap-3 py-1">
                    <span className={cx('size-2.5 shrink-0 rounded-full', style.dot)} aria-hidden />
                    <span className={cx('min-w-0 flex-1 truncate', style.text)}>
                      {CHECK_TITLES[key] ?? key}
                    </span>
                    <span className="text-sm text-fg-2">{style.label}</span>
                  </div>
                )
              })}
            </Panel>

            <Panel title="Версии" hint="Фиксируются в provenance каждого результата анализа">
              {Object.entries(init.data.versions).map(([name, version]) => (
                <InfoRow key={name} label={name} value={version} mono />
              ))}
              {meta.data ? (
                <>
                  <InfoRow label="platform" value={meta.data.platform} mono />
                  <InfoRow label="БД" value={meta.data.database_backend} mono />
                </>
              ) : null}
            </Panel>
          </Column>

          <Column title="Пути и параметры">
            <Panel title="Каталоги данных">
              {Object.entries(init.data.paths).map(([name, path]) => (
                <InfoRow key={name} label={name} value={path} mono />
              ))}
            </Panel>

            <Panel title="API и UI">
              <InfoRow label="api_prefix" value={init.data.api.prefix} mono />
              <InfoRow label="Swagger" value={init.data.api.docs_url} mono />
              <InfoRow label="meta" value={init.data.api.meta_url} mono />
              <InfoRow label="UI собран" value={init.data.ui.built} />
              <InfoRow
                label="Код бэкенда"
                value={
                  init.data.code.stale
                    ? 'устарел — код новее сервера'
                    : `свежий (${init.data.code.code_mtime})`
                }
              />
              {init.data.code.stale ? (
                <p className="text-sm text-warn">
                  Бэкенд работает на старом коде: перезапустите его кнопкой ниже (с `--reload` такого не
                  бывает) и пересчитайте запись — файлы задач и результаты переживают перезагрузку.
                </p>
              ) : null}

              {/* Управление перезапуском: подтверждение → ожидание → успех */}
              <div className="space-y-2 pt-1">
                {phase === 'idle' || phase === 'done' ? (
                  <Button
                    icon={<RotateCcw className="size-4" />}
                    disabled={restarting}
                    onClick={askConfirm}
                  >
                    Перезапустить бэкенд
                  </Button>
                ) : null}
                {phase === 'done' ? (
                  <p className="text-sm text-ok">
                    Бэкенд перезапущен — пересчитайте запись: файлы задач и результаты стадий
                    переживают перезапуск и отдают прежние числа.
                  </p>
                ) : null}
                {phase === 'confirm' ? (
                  <div className="space-y-2">
                    <p className="text-sm text-fg-1">
                      Перезапустить сервер сейчас?
                      {busyJobs !== null ? ` Активных задач: ${busyJobs}.` : ''}
                      {busyJobs ? ' Дождитесь их завершения — иначе расчёт оборвётся.' : ''}
                    </p>
                    <div className="flex gap-2">
                      <Button variant="primary" onClick={doRestart}>
                        Да, перезапустить
                      </Button>
                      <Button onClick={() => setPhase('idle')}>Отмена</Button>
                    </div>
                  </div>
                ) : null}
                {restarting ? (
                  <p className="text-sm text-fg-1 animate-pulse">
                    Перезапускаем бэкенд… секунды, страница переподключится сама.
                  </p>
                ) : null}
                {restartError ? (
                  <p className="text-sm text-danger" role="alert">
                    {restartError}
                  </p>
                ) : null}
              </div>
              <InfoRow label="UI URL" value={init.data.ui.url} mono />
              <InfoRow label="Legacy" value={init.data.ui.legacy_url} mono />
            </Panel>

            {meta.data ? (
              <Panel
                title="Параметры расчёта"
                hint="Изменяются в backend/.env — единый источник конфигурации для сервера и Docker"
              >
                <InfoRow label="Диапазоны, Гц" value={JSON.stringify(meta.data.freq_bands)} mono />
                <InfoRow
                  label="Длины эпох, мс"
                  value={meta.data.epoch_lengths_ms.join(', ')}
                  mono
                />
                <InfoRow label="Каналы 10-20" value={meta.data.standard_channels.length} mono />
                <InfoRow label="decim фитинга" value={meta.data.dipole_fit_decim} mono />
                <InfoRow label="max эпох" value={meta.data.dipole_fit_max_epochs} mono />
                <InfoRow label="z-порог" value={meta.data.artifact_thresholds.z_score_threshold} mono />
                <InfoRow label="Окно z-score, с" value={meta.data.artifact_thresholds.zscore_window_sec} mono />
                <InfoRow label="параллельных задач" value={meta.data.max_concurrent_jobs} mono />
                <InfoRow label="surface version" value={meta.data.surface_version} mono />
              </Panel>
            ) : null}
          </Column>
        </div>
      ) : null}
    </div>
  )
}
