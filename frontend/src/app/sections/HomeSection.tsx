/** Главная: заставка-название по центру + состояние готовности и быстрые действия. */
import { useQuery } from '@tanstack/react-query'
import { FolderOpen, ServerCog } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api } from '@/shared/api/client'
import { Button } from '@/shared/ui/Button'

export function HomeSection() {
  const navigate = useNavigate()

  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: ({ signal }) => api.meta(signal),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const init = useQuery({
    queryKey: ['initStatus'],
    queryFn: ({ signal }) => api.initStatus(signal),
    staleTime: 15_000,
    retry: false,
  })

  const readiness = init.isError
    ? 'Сервер недоступен — запустите backend (uvicorn app.main:app --port 8000)'
    : init.isPending
      ? 'Проверяем готовность компонентов…'
      : init.data?.status === 'ready'
        ? 'Все компоненты готовы к работе'
        : 'Часть компонентов не готова — откройте «Состояние сервера»'

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 px-10 text-center">
      <div className="flex items-center gap-4">
        <span className="text-6xl select-none" aria-hidden>
          🧠
        </span>
        <h1 className="text-5xl font-bold tracking-tight text-fg-0">DipLock</h1>
      </div>

      <p className="text-xl text-fg-1">Анализ ЭЭГ и расчёт токовых диполей в 3D</p>
      <p className="text-base text-fg-2">{readiness}</p>

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          icon={<FolderOpen className="size-5" />}
          onClick={() => navigate('/edf')}
        >
          Открыть EDF
        </Button>
        <Button icon={<ServerCog className="size-5" />} onClick={() => navigate('/server')}>
          Состояние сервера
        </Button>
      </div>

      {meta.data ? (
        <p className="tnum text-sm text-fg-2">
          версия {meta.data.app_version} · MNE {meta.data.mne_version} · БД{' '}
          {meta.data.database_backend}
        </p>
      ) : null}
    </div>
  )
}
