/**
 * Правая панель чата консилиума: роли агентов — включение, инструкция, модель
 * из модельного роутера, уровень размышления и навыки специалиста (правка
 * ничего не запускает; сохраняет только кнопка).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { agentChatApi } from '@/shared/api/agentChat'
import { apiErrorText } from '@/shared/api/client'
import { llmRouterApi } from '@/shared/api/llmRouter'
import type { AgentRole, LlmProvider } from '@/shared/api/types'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { Panel } from '@/shared/ui/Panel'
import { SelectField } from '@/shared/ui/SelectField'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { TextField } from '@/shared/ui/TextField'

const DEFAULT_MODEL = ''

const REASONING_OPTIONS = [
  { value: '', label: 'Не задан (по инструкции)' },
  { value: 'low', label: 'Низкий — коротко и сразу' },
  { value: 'medium', label: 'Обычный — краткий ход мысли' },
  { value: 'high', label: 'Высокий — перебор вариантов' },
]

function splitModels(provider: LlmProvider | undefined): string[] {
  return (provider?.model ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Навыки из поля «через запятую»: пустые элементы отбрасываются. */
function parseSkills(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function RoleEditor({ role, providers }: { role: AgentRole; providers: LlmProvider[] }) {
  const queryClient = useQueryClient()
  const [label, setLabel] = useState(role.label)
  const [instruction, setInstruction] = useState(role.instruction)
  const [providerId, setProviderId] = useState(role.provider_id ?? '')
  const [model, setModel] = useState(role.model ?? DEFAULT_MODEL)
  const [reasoning, setReasoning] = useState(role.reasoning ?? '')
  const [skills, setSkills] = useState(role.skills.join(', '))
  const provider = providers.find((item) => item.id === providerId)
  const models = splitModels(provider)

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['agent-chat', 'roles'] })
  const save = useMutation({
    mutationFn: () =>
      agentChatApi.updateRole(role.id, {
        label,
        instruction,
        provider_id: providerId,
        model: providerId ? model : '',
        reasoning: reasoning === '' ? null : (reasoning as AgentRole['reasoning']),
        skills: parseSkills(skills),
      }),
    onSuccess: refresh,
  })
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => agentChatApi.updateRole(role.id, { enabled }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: () => agentChatApi.deleteRole(role.id),
    onSuccess: refresh,
  })

  return (
    <details className="rounded-lg border border-border p-2">
      <summary className="cursor-pointer text-fg-0">
        {role.label}
        {!role.enabled && <span className="ml-2 text-sm text-fg-2">(выключена)</span>}
      </summary>
      <div className="mt-2 space-y-2">
        <CheckboxRow
          label="Участвует в чате"
          checked={role.enabled}
          onChange={(value) => toggle.mutate(value)}
        />
        <TextField label="Название (по нему адресуют @)" value={label} onChange={setLabel} />
        <label className="block space-y-1 text-sm text-fg-1">
          <span>Инструкция роли</span>
          <textarea
            className="min-h-32 w-full rounded-lg border border-border bg-bg-2 p-2 text-base text-fg-0"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
        </label>
        <SelectField
          label="Провайдер"
          value={providerId}
          options={[
            { value: '', label: 'Маршрут «chat» роутера' },
            ...providers.map((item) => ({ value: item.id, label: item.label })),
          ]}
          onChange={(value) => {
            setProviderId(value)
            setModel(splitModels(providers.find((item) => item.id === value))[0] ?? '')
          }}
        />
        {providerId && (
          <SelectField
            label="Модель"
            value={model}
            options={models.map((item) => ({ value: item, label: item }))}
            onChange={setModel}
          />
        )}
        <SelectField
          label="Уровень размышления"
          value={reasoning}
          options={REASONING_OPTIONS}
          onChange={setReasoning}
        />
        <TextField
          label="Навыки специалиста (через запятую)"
          value={skills}
          onChange={setSkills}
          placeholder="статистика, ЭЭГ-артефакты"
        />
        <div className="flex gap-2">
          <Button disabled={save.isPending || !label.trim() || !instruction.trim()} onClick={() => save.mutate()}>
            Сохранить роль
          </Button>
          {!role.builtin && (
            <Button variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate()}>
              Удалить
            </Button>
          )}
        </div>
        {[save.error, toggle.error, remove.error].map(
          (error, index) =>
            error != null && <ErrorBlock key={index} message={apiErrorText(error)} />,
        )}
      </div>
    </details>
  )
}

function NewRole({ providers }: { providers: LlmProvider[] }) {
  const queryClient = useQueryClient()
  const [label, setLabel] = useState('')
  const [instruction, setInstruction] = useState('')
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState(DEFAULT_MODEL)
  const [reasoning, setReasoning] = useState('')
  const [skills, setSkills] = useState('')
  const models = splitModels(providers.find((item) => item.id === providerId))
  const create = useMutation({
    mutationFn: () =>
      agentChatApi.createRole({
        label,
        instruction,
        provider_id: providerId || null,
        model: providerId ? model || null : null,
        reasoning: reasoning === '' ? null : (reasoning as AgentRole['reasoning']),
        skills: parseSkills(skills),
      }),
    onSuccess: async () => {
      setLabel('')
      setInstruction('')
      setProviderId('')
      setModel(DEFAULT_MODEL)
      setReasoning('')
      setSkills('')
      await queryClient.invalidateQueries({ queryKey: ['agent-chat', 'roles'] })
    },
  })
  return (
    <div className="space-y-2">
      <TextField label="Название" value={label} onChange={setLabel} placeholder="Скептик" />
      <label className="block space-y-1 text-sm text-fg-1">
        <span>Инструкция</span>
        <textarea
          className="min-h-24 w-full rounded-lg border border-border bg-bg-2 p-2 text-base text-fg-0"
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </label>
      <SelectField
        label="Провайдер"
        value={providerId}
        options={[
          { value: '', label: 'Маршрут «chat» роутера' },
          ...providers.map((item) => ({ value: item.id, label: item.label })),
        ]}
        onChange={(value) => {
          setProviderId(value)
          setModel(splitModels(providers.find((item) => item.id === value))[0] ?? '')
        }}
      />
      {providerId && (
        <SelectField
          label="Модель"
          value={model}
          options={models.map((item) => ({ value: item, label: item }))}
          onChange={setModel}
        />
      )}
      <SelectField
        label="Уровень размышления"
        value={reasoning}
        options={REASONING_OPTIONS}
        onChange={setReasoning}
      />
      <TextField
        label="Навыки специалиста (через запятую)"
        value={skills}
        onChange={setSkills}
        placeholder="статистика, ЭЭГ-артефакты"
      />
      <Button
        disabled={create.isPending || !label.trim() || !instruction.trim()}
        onClick={() => create.mutate()}
      >
        Добавить советника
      </Button>
      {create.error != null && <ErrorBlock message={apiErrorText(create.error)} />}
    </div>
  )
}

export function AgentChatPanel() {
  const roles = useQuery({
    queryKey: ['agent-chat', 'roles'],
    queryFn: ({ signal }) => agentChatApi.roles(signal),
  })
  const router = useQuery({
    queryKey: ['llm-router'],
    queryFn: ({ signal }) => llmRouterApi.get(signal),
  })
  const providers = (router.data?.providers ?? []).filter((item) => item.enabled)

  return (
    <>
      <Panel title="Эксперты" hint="Инструкции и модели ролей; сохраняет только кнопка.">
        {roles.isPending && <LoadingBlock label="Загрузка ролей..." />}
        {roles.error != null && <ErrorBlock message={apiErrorText(roles.error)} />}
        <div className="space-y-2">
          {(roles.data?.items ?? []).map((role) => (
            <RoleEditor key={`${role.id}-${role.label}`} role={role} providers={providers} />
          ))}
        </div>
      </Panel>
      <Panel title="Новый советник">
        <NewRole providers={providers} />
      </Panel>
      <Panel title="Подсказка">
        <p className="text-sm text-fg-1">
          Провайдеры и ключи задаются в «Настройки → Модельный роутер ИИ». Роль без
          своего провайдера использует маршрут «chat». Уровень размышления и навыки
          специалиста попадают в инструкцию роли — это директива модели, а не
          параметр API провайдера.
        </p>
      </Panel>
    </>
  )
}
