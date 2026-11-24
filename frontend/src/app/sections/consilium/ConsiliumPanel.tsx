/**
 * Панель опций раздела «Консилиум»: в чате — настройки ролевых советников,
 * в «Знаниях» — отсылка к ним (своего сайдбара у библиотеки нет).
 */
import { useSearchParams } from 'react-router-dom'
import { Panel } from '@/shared/ui/Panel'
import { AgentChatPanel } from '../agentchat/AgentChatPanel'

export function ConsiliumPanel() {
  const [params] = useSearchParams()
  const view = params.get('view') === 'knowledge' ? 'knowledge' : 'chat'

  if (view === 'knowledge') {
    return (
      <Panel title="Настройки советников">
        <p className="text-sm text-fg-1">
          Роли, провайдеры, модели, уровень размышления и навыки специалиста
          настраиваются во вкладке «Чат экспертов».
        </p>
      </Panel>
    )
  }
  return <AgentChatPanel />
}
