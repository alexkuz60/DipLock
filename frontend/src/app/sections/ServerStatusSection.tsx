/**
 * Состояние сервера: готовность компонентов (MNE, БД, fsaverage, transform, BEM),
 * версии библиотек, пути данных и активные параметры расчёта.
 *
 * Поллинг — 5 с и только пока открыта вкладка (react-query не опрашивает сервер
 * в скрытой вкладке), плюс кнопка «Проверить сейчас».
 */
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
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

function Column({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 flex-1 space-y-3">
      <h2 className="text-sm font-semibold tracking-wide text-fg-2 uppercase">{title}</h2>
      {children}
    </div>
  )
}

export function ServerStatusSection() {
  const init = useQuery({
    queryKey: ['initStatus'],
    queryFn: ({ signal }) => api.initStatus(signal),
    staleTime: 0,
    refetchInterval: 5000,
    retry: false,
  })
  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 60_000,
    retry: false,
  })

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
      {init.isError ? (
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
