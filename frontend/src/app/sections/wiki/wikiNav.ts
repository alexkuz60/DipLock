/**
 * Навигация раздела Wiki: реестр статей, контекст переходов и разбор хеша.
 *
 * Хеш маршрута — пермалинк: `/wiki#artifacts` открывает статью,
 * `/wiki#glossary/term-ica` — якорь внутри неё. Метаданные статей лежат здесь
 * (а не в компонентах), чтобы оглавление и тесты не тянули контент: сами
 * статьи — компоненты в `articles/*`, связка «id → компонент» — `WikiSection`.
 */
import { createContext, useContext } from 'react'
import {
  Activity,
  BookMarked,
  Brain,
  Calculator,
  Compass,
  Filter,
  FolderOpen,
  Monitor,
  Play,
  ScanSearch,
  Scissors,
  Sparkles,
  type LucideIcon,
} from 'lucide-react'

export type WikiArticleId =
  | 'intro'
  | 'open'
  | 'screen'
  | 'filter'
  | 'artifacts'
  | 'clean'
  | 'epochs'
  | 'dipoles'
  | 'dipole-calc'
  | 'dipole-playback'
  | 'eeg-screen'
  | 'glossary'

export type WikiArticle = {
  id: WikiArticleId
  /** Полный заголовок статьи (заголовок в тексте и пункт оглавления) */
  title: string
  /** Короткая подпись для оглавления и кнопок «Назад/Вперёд» */
  short: string
  /** Подсказка при наведении на пункт оглавления */
  hint: string
  icon: LucideIcon
}

/** Статьи в порядке чтения: обзор → шаги препроцессинга → глоссарий */
export const WIKI_ARTICLES: WikiArticle[] = [
  {
    id: 'intro',
    title: 'Введение: путь от файла до эпох',
    short: 'Введение',
    hint: 'Зачем препроцессинг и из чего состоит рабочий цикл',
    icon: Compass,
  },
  {
    id: 'open',
    title: 'Шаг 0. Открытие записи',
    short: 'Открытие',
    hint: 'Загрузка EDF, паспорт сессии, закрытие записи',
    icon: FolderOpen,
  },
  {
    id: 'screen',
    title: 'Экран раздела EDF: что где находится',
    short: 'Экран',
    hint: 'Шапка с кнопками, треки, легенда, панель опций, статусбар',
    icon: Monitor,
  },
  {
    id: 'filter',
    title: 'Шаг 1. Фильтры, референс и АЧХ',
    short: 'Фильтрация',
    hint: 'Полоса, notch, референс, АЧХ-отклик, сетевой фон',
    icon: Filter,
  },
  {
    id: 'artifacts',
    title: 'Шаг 2. Поиск артефактов',
    short: 'Артефакты',
    hint: 'Пороги, виды артефактов, QC-светофор, навигация по зонам',
    icon: ScanSearch,
  },
  {
    id: 'clean',
    title: 'Шаг 3. Чистка сигнала',
    short: 'Чистка',
    hint: 'ICA/SSP, плохие каналы, зоны вклада и метрики потерь',
    icon: Sparkles,
  },
  {
    id: 'epochs',
    title: 'Шаг 4. Нарезка эпох и диапазоны',
    short: 'Эпохи',
    hint: 'Эпохи, события, отбраковка, ERP и частотные полосы',
    icon: Scissors,
  },
  {
    id: 'dipoles',
    title: 'Диполи: обзор и три проекции',
    short: 'Диполи: обзор',
    hint: 'Экран раздела «Диполи»: проекции, слои, панель, выделение точки',
    icon: Brain,
  },
  {
    id: 'dipole-calc',
    title: 'Диполи: расчёт и уточнение',
    short: 'Диполи: расчёт',
    hint: 'Быстрый режим, параметры задачи, порог «КД», точный фитинг, таблица',
    icon: Calculator,
  },
  {
    id: 'dipole-playback',
    title: 'Диполи: воспроизведение траектории',
    short: 'Диполи: кадр',
    hint: 'Кадр по эпохам, скорость, шлейф, анатомия кадра',
    icon: Play,
  },
  {
    id: 'eeg-screen',
    title: 'Работа со страницей ЭЭГ/Спектр',
    short: 'ЭЭГ/Спектр',
    hint: 'Две половины и курсор, шапка с зумами, расчёт спектрограммы, палитра',
    icon: Activity,
  },
  {
    id: 'glossary',
    title: 'Глоссарий',
    short: 'Глоссарий',
    hint: 'Термины и сокращения по порядку алфавита групп',
    icon: BookMarked,
  },
]

export const WIKI_ARTICLE_IDS: WikiArticleId[] = WIKI_ARTICLES.map((article) => article.id)

/** Статья по id (undefined — неизвестный id из хеша) */
export function wikiArticle(id: string): WikiArticle | undefined {
  return WIKI_ARTICLES.find((article) => article.id === id)
}

export type WikiNavValue = {
  /** Открытая сейчас статья */
  active: WikiArticleId
  /**
   * Переход к статье (и опционально к якорю внутри неё).
   * Реализация в `WikiSection` пишет хеш маршрута — так ссылки остаются
   * пермалинками и работают кнопки «назад/вперёд» браузера.
   */
  goTo: (id: WikiArticleId, anchor?: string) => void
}

/** Значение по умолчанию — вне `WikiSection` (статьи тестируются изолированно) */
export const WikiNavContext = createContext<WikiNavValue>({
  active: 'intro',
  goTo: () => {},
})

export function useWikiNav(): WikiNavValue {
  return useContext(WikiNavContext)
}

export type ParsedWikiHash = {
  /** Статья из хеша; null — хеш пуст или неизвестен (откроется «Введение») */
  article: WikiArticleId | null
  /** Якорь внутри статьи (`#glossary/term-ica` → `term-ica`) */
  anchor: string | null
}

/** Разбор хеша маршрута: `#id` или `#id/anchor` */
export function parseWikiHash(hash: string): ParsedWikiHash {
  const raw = hash.replace(/^#/, '')
  if (!raw) return { article: null, anchor: null }
  const [id = '', anchor] = raw.split('/')
  return {
    article: wikiArticle(id) ? (id as WikiArticleId) : null,
    anchor: anchor || null,
  }
}

/** Сборка хеша для перехода (используется `WikiSection`) */
export function wikiHash(id: WikiArticleId, anchor?: string): string {
  return anchor ? `#${id}/${anchor}` : `#${id}`
}

/** Соседняя статья в порядке чтения (delta = ±1); undefined — край оглавления */
export function adjacentArticle(
  id: WikiArticleId,
  delta: 1 | -1,
): WikiArticle | undefined {
  const index = WIKI_ARTICLE_IDS.indexOf(id)
  return WIKI_ARTICLES[index + delta]
}