/** Статусбар: версия и адрес API, состояние сервера, активный раздел. */
import { useQuery } from '@tanstack/react-query'
import type { SectionConfig } from '@/app/sections/registry'
import { api } from '@/shared/api/client'
import { TIME_LEVELS, useEdfParams } from '@/shared/state/edfParams'
import { cx } from '@/shared/ui/cx'
import { Tooltip } from '@/shared/ui/Tooltip'

type ServerState = 'ready' | 'pending' | 'error' | 'unknown'

const SERVER_LABEL: Record<ServerState, string> = {
  ready: 'Сервер готов',
  pending: 'Сервер инициализируется',
  error: 'Сервер недоступен',
  unknown: 'Состояние сервера неизвестно',
}

const SERVER_DOT: Record<ServerState, string> = {
  ready: 'bg-ok',
  pending: 'bg-warn',
  error: 'bg-danger',
  unknown: 'bg-fg-2',
}

export function StatusBar({ section }: { section: SectionConfig }) {
  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 5 * 60_000,
    retry: false,
  })

  // Поллинг только при открытой вкладке: react-query не опрашивает сервер в фоне
  const init = useQuery({
    queryKey: ['initStatus'],
    queryFn: ({ signal }) => api.initStatus(signal),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  })

  const serverState: ServerState = init.isError
    ? 'error'
    : (init.data?.status as ServerState | undefined) ?? 'unknown'

  return (
    <footer className="flex h-8 shrink-0 items-center gap-4 border-t border-border bg-bg-1 px-3 text-xs text-fg-2">
      <span className="tnum">
        {meta.data ? `${meta.data.app} v${meta.data.app_version}` : 'DipLock'}
      </span>
      <span className="tnum">API {meta.data?.api_prefix ?? '/api/v1'}</span>

      <Tooltip label={SERVER_LABEL[serverState]} side="top">
        <span className="flex items-center gap-2">
          <span className={cx('size-2 rounded-full', SERVER_DOT[serverState])} aria-hidden />
          <span>{SERVER_LABEL[serverState]}</span>
        </span>
      </Tooltip>

      <span className="ml-auto flex items-center gap-4">
        {section.id === 'edf' ? <EdfZoomIndicator /> : null}
        {meta.data ? (
          <span className="tnum">surface v{meta.data.surface_version}</span>
        ) : null}
        <span>
          Раздел: <span className="text-fg-1">{section.shortTitle}</span>
          {section.hotkey ? <span className="tnum"> (клавиша {section.hotkey})</span> : null}
        </span>
      </span>
    </footer>
  )
}

/**
 * Индикатор зума вьюера: масштаб задаётся в панели раздела EDF,
 * но видеть его нужно и в рабочей области (docs/ui.md).
 */
function EdfZoomIndicator() {
  const level = useEdfParams((state) => state.params.timeLevel)
  const factor = TIME_LEVELS[level] ?? 1
  return <span className="tnum">Зум треков ×{factor}</span>
}
