/**
 * Разделы-заглушки: каркас и панель опций готовы, функционал реализуется в
 * следующих фазах — планы перечислены в `docs/ui.md` и `docs/ui/summary.md`.
 *
 * Таблица локализации перестала быть заглушкой в срезе 4 и живёт в
 * `sections/table/`; групповой анализ — Фаза 5 (требует read-API и наполнения
 * БД); ЕмоЛаб и Нейроаудио — новые направления (срез «Итоги», 01.10.2026):
 * разделы стоят в меню, чтобы навигация и хоткеи не менялись потом.
 */
import type { ReactNode } from 'react'
import { Headphones, Layers, Smile } from 'lucide-react'
import { Placeholder } from '@/shared/ui/Placeholder'
import { Panel } from '@/shared/ui/Panel'

type StubProps = {
  icon: ReactNode
  title: string
  description: string
  planned: string[]
  phase: string
}

function StubSection({ icon, title, description, planned, phase }: StubProps) {
  return (
    <Placeholder icon={icon} title={title} description={description}>
      <p className="rounded-lg border border-border bg-bg-2 px-3 py-1.5 text-sm text-fg-2">
        {phase}
      </p>
      <ul className="mt-2 space-y-1 text-left text-sm text-fg-2">
        {planned.map((item) => (
          <li key={item} className="flex gap-2">
            <span aria-hidden>•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </Placeholder>
  )
}

function StubPanel({ title, options }: { title: string; options: string[] }) {
  return (
    <Panel title={title} hint="Опции раздела появятся вместе с его функционалом">
      <ul className="space-y-1 text-sm text-fg-2">
        {options.map((option) => (
          <li key={option} className="ui-list-row py-1">
            {option}
          </li>
        ))}
      </ul>
    </Panel>
  )
}

export function GroupAnalysisSection() {
  return (
    <StubSection
      phase="Фаза 5: групповой анализ (требует read-API и наполнения БД)"
      icon={<Layers className="size-12" />}
      title="Групповой анализ"
      description="Сравнение записей из базы: групповые фильтры, агрегаты по полям Бродмана, поиск общих закономерностей."
      planned={[
        'Список сессий из БД с параметрами анализа каждой записи',
        'Групповая фильтрация: диапазон, длина эпохи, GOF, BA/ROI, файл, дата',
        'Агрегаты: число диполей, средняя/стд амплитуда, средний GOF по BA',
        'Тепловая карта «BA × сессии», топ-области',
        'Экспорт групповой сводки',
      ]}
    />
  )
}

export function GroupAnalysisPanel() {
  return (
    <StubPanel
      title="Параметры группы"
      options={[
        'Набор сессий (чекбоксы)',
        'Фильтры по параметрам анализа',
        'Метрика агрегации',
        'Период и источник записей',
      ]}
    />
  )
}

export function EmoLabSection() {
  return (
    <StubSection
      phase="Направление «ЕмоЛаб»: исследовательский раздел, наполнение — отдельным срезом"
      icon={<Smile className="size-12" />}
      title="ЕмоЛаб — психоэмоциональный фон"
      description="Анализ психоэмоционального состояния по ЭЭГ: маркеры аффективных режимов, их динамика по записи и связь с активностью структур из отчёта."
      planned={[
        'Каталог маркеров аффективного фона (частотные и нелинейные показатели)',
        'Динамика маркеров по записи с привязкой к артефактам и эпохам',
        'Сводка по полосам с перекрёстной ссылкой на «Итоги»',
        'Экспорт отчёта по сессии',
      ]}
    />
  )
}

export function EmoLabPanel() {
  return (
    <StubPanel
      title="Параметры анализа"
      options={[
        'Окно анализа и шаг динамики',
        'Набор маркеров аффективного фона',
        'Привязка к стадиям препроцессинга',
      ]}
    />
  )
}

export function NeuroAudioSection() {
  return (
    <StubSection
      phase="Направление «Нейроаудио»: исследовательский раздел, наполнение — отдельным срезом"
      icon={<Headphones className="size-12" />}
      title="Нейроаудио — аудиовход и ритмы"
      description="Анализ ответа на аудиостимуляцию: события звукового входа, осцилляторный ответ по полосам и его локализация диполями."
      planned={[
        'События аудиовхода из записи (EDF+-аннотации / стим-канал)',
        'Усреднённый осцилляторный ответ по полосам (ERP-подход, шаг 2.7)',
        'Локализация генераторов ответа в полях Бродмана',
        'Сравнение с базовой линией покоя',
      ]}
    />
  )
}

export function NeuroAudioPanel() {
  return (
    <StubPanel
      title="Параметры аудиоанализа"
      options={[
        'Описание события стимула',
        'Окно ответа до/после стимула',
        'Набор полос для осцилляторного ответа',
      ]}
    />
  )
}
