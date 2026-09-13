/**
 * Разделы-заглушки (Фаза 1): каркас и панель опций готовы, функционал
 * реализуется в следующих фазах — планы перечислены в `docs/ui.md`.
 */
import type { ReactNode } from 'react'
import { Layers, Radar, Table2, Waves } from 'lucide-react'
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

export function EdfSection() {
  return (
    <StubSection
      phase="Фаза 2: рабочая область просмотра записи (параметры в правой панели уже работают)"
      icon={<Waves className="size-12" />}
      title="EDF — просмотр записи"
      description="Мультитрековый просмотр ЭЭГ, зоны артефактов, маркеры эпох и инструменты предподготовки."
      planned={[
        'Загрузка EDF (drag & drop) с прогрессом и валидацией',
        '18 треков 10-20 на canvas, дефолт-зум — вся сессия',
        'Дискретные уровни зума x1 / x2 / x4 / x8 / x16 (min/max-огибающая)',
        'Цветовые зоны артефактов и границы эпох, штриховка отброшенных эпох',
        'Кнопка «Пересчитать предподготовку»: задача артефактов и эпох (без фитинга диполей)',
      ]}
    />
  )
}

export function DipolesSection() {
  return (
    <StubSection
      phase="Фаза 3: расчёт диполей и локализация"
      icon={<Radar className="size-12" />}
      title="Расчёт диполей и локализация"
      description="Частотная фильтрация, фитинг диполей по эпохам, 3 проекции и анимация траектории."
      planned={[
        'Форма фильтров: δ/θ/α/β/γ, custom range, одиночная частота (7.83 Гц)',
        'Фоновая задача с прогрессом по этапам и возможностью дождаться результата',
        'Три проекции: axial / sagittal / coronal + 3D-меш (GLB, кэш)',
        'Timeline-playback: воспроизведение траектории, скорость, покадрово',
        'График GOF по времени, фильтр эпох по GOF, подсветка Brodmann-областей',
      ]}
    />
  )
}

export function DipolesPanel() {
  return (
    <StubPanel
      title="Параметры расчёта"
      options={[
        'Частотный диапазон и одиночная частота',
        'Порог GOF для отбора эпох',
        'Профиль: fast (превью) / accurate',
        'Подсветка ROI и полей Бродмана',
        'Слои: меш, траектория, эпоха-фокус',
      ]}
    />
  )
}

export function LocalizationTableSection() {
  return (
    <StubSection
      phase="Фаза 4: таблица результатов"
      icon={<Table2 className="size-12" />}
      title="Таблица локализации"
      description="Виртуализованная таблица лучших диполей: MNI-координаты, амплитуда, GOF, ROI и поля Бродмана."
      planned={[
        'Сортировка, фильтры, поиск по всем колонкам',
        'Группировка по полю Бродмана и полушарию',
        'Клик по строке — фокус на диполе в разделе «Диполи»',
        'Экспорт выборки в CSV / JSON',
      ]}
    />
  )
}

export function LocalizationTablePanel() {
  return (
    <StubPanel
      title="Настройки таблицы"
      options={['Видимые колонки', 'Фильтр по GOF и амплитуде', 'Фильтр по BA/ROI', 'Экспорт выборки']}
    />
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
