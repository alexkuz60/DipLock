import { useSearchParams } from 'react-router-dom'
import { AgentChatPanel } from '../agentchat/AgentChatPanel'
import { ConsiliumOptionsPanel } from './ConsiliumOptionsPanel'

/** Панель соответствует выбранной вкладке раздела Консилиума. */
export function ConsiliumPanel() {
  const [params] = useSearchParams()
  return params.get('view') === 'chat' ? <AgentChatPanel /> : <ConsiliumOptionsPanel />
}
