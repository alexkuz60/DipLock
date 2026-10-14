/**
 * Панель «Опции» Консилиума (срез 0014): разовые настройки обсуждения
 * в правом сайдбаре, чтобы основная область осталась под работой с делом.
 *
 * Правка опции ничего не запускает («правило кнопки»,
 * `docs/rules/frontend-state.md`): раунды и запросы к внешним моделям
 * стартуют только кнопками рабочей области.
 */
import { useConsiliumOptions } from '@/shared/state/consiliumOptions'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { Panel } from '@/shared/ui/Panel'
import { advisorRoles } from './options'

/** Советники без «Итога»: итог — действие раунда, а не роль для запуска. */
const ADVISOR_ROLES = advisorRoles.filter((role) => role.value !== 'summary')

export function ConsiliumOptionsPanel() {
  const options = useConsiliumOptions((state) => state.options)
  const toggleRole = useConsiliumOptions((state) => state.toggleRole)
  const toggleRoleFilter = useConsiliumOptions((state) => state.toggleRoleFilter)
  const setOpenAnswerSections = useConsiliumOptions((state) => state.setOpenAnswerSections)

  return (
    <>
      <Panel title="Советники" hint="Роли раунда и фильтр карточек обсуждения.">
        <p className="text-sm text-fg-2">Роли для запуска раунда</p>
        {ADVISOR_ROLES.map((role) => (
          <CheckboxRow
            key={`role-${role.value}`}
            label={role.label}
            checked={options.roles.includes(role.value)}
            onChange={() => toggleRole(role.value)}
          />
        ))}
        <p className="mt-2 text-sm text-fg-2">Показывать в обсуждении</p>
        {ADVISOR_ROLES.map((role) => (
          <CheckboxRow
            key={`filter-${role.value}`}
            label={role.label}
            checked={options.roleFilter.includes(role.value)}
            onChange={() => toggleRoleFilter(role.value)}
          />
        ))}
      </Panel>

      <Panel title="Отображение">
        <CheckboxRow
          label="Раскрывать разделы ответов сразу"
          hint="Разделы советника и «На чём основано?» — без отдельных нажатий."
          checked={options.openAnswerSections}
          onChange={setOpenAnswerSections}
        />
      </Panel>

      <Panel title="О разделе">
        <div className="space-y-3 text-sm text-fg-1">
          <p>
            Сформулируйте вопрос, добавьте рассказ добровольца и выберите результаты конкретных
            прогонов.
          </p>
          <p>Досье сохраняет то, что вы обсуждали: новый расчёт не меняет прошлый снимок.</p>
          <p>
            Измерения и модели, рассказ человека и ваши наблюдения — разные основания. Подробности
            доступны по раскрытию.
          </p>
          <p>
            ИИ-советники отвечают по снимку досье; запросы к внешним моделям запускаются только
            кнопками и видны в обсуждении. Стенография беседы появится отдельным этапом.
          </p>
        </div>
      </Panel>
    </>
  )
}