/**
 * Примитивы оформления статей Wiki: врезки Callout, шаги, таблицы параметров,
 * перекрёстные ссылки между статьями и глоссарием.
 *
 * Контент — статичный TSX без markdown-зависимостей: цвет и рамки берут
 * токены темы (`accent/ok/warn/danger`), ссылки внутри Wiki ходят через
 * контекст `WikiNavContext`, в разделы приложения — через react-router.
 */
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowRight, CircleX, Info, Lightbulb } from 'lucide-react'
import { cx } from '@/shared/ui/cx'
import { glossaryEntry } from './glossary'
import { useWikiNav, wikiHash, type WikiArticleId } from './wikiNav'

/* ---------- Заголовки и текст ---------- */

/** Заголовок статьи (в тексте он — `h2`: `h1` принадлежит шапке раздела) */
export function ArticleTitle({ children, lead }: { children: ReactNode; lead?: ReactNode }) {
  return (
    <header className="border-b border-border pb-4">
      <h2 className="text-2xl font-bold text-fg-0">{children}</h2>
      {lead ? <p className="mt-2 max-w-3xl text-base text-fg-1">{lead}</p> : null}
    </header>
  )
}

/** Подзаголовок внутри статьи */
export function H3({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <h3 id={id} className="mt-8 scroll-mt-4 text-lg font-semibold text-fg-0">
      {children}
    </h3>
  )
}

/** Абзац статьи */
export function P({ children }: { children: ReactNode }) {
  return <p className="mt-3 max-w-3xl leading-relaxed text-fg-1">{children}</p>
}

/** Маркированный список */
export function Ul({ children }: { children: ReactNode }) {
  return <ul className="mt-3 max-w-3xl list-disc space-y-1.5 pl-6 text-fg-1">{children}</ul>
}

/* ---------- Врезки и рамки ---------- */

export type CalloutTone = 'info' | 'tip' | 'warn' | 'danger'

const CALLOUT_STYLES: Record<CalloutTone, { box: string; title: string }> = {
  info: { box: 'border-accent/50 bg-accent-soft', title: 'text-fg-0' },
  tip: { box: 'border-ok/40 bg-ok/10', title: 'text-ok' },
  warn: { box: 'border-warn/40 bg-warn/10', title: 'text-warn' },
  danger: { box: 'border-danger/40 bg-danger/10', title: 'text-danger' },
}

const CALLOUT_ICONS = { info: Info, tip: Lightbulb, warn: AlertTriangle, danger: CircleX }

/**
 * Цветная врезка: `info` — пояснение, `tip` — совет, `warn` — предупреждение,
 * `danger` — ограничение. Цвет дублируется заголовком — доступность по `docs/ui.md`.
 */
export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: CalloutTone
  title: string
  children: ReactNode
}) {
  const style = CALLOUT_STYLES[tone]
  const Icon = CALLOUT_ICONS[tone]
  return (
    <aside className={cx('mt-4 max-w-3xl rounded-xl border-l-4 p-4', style.box)} data-tone={tone}>
      <p className={cx('flex items-center gap-2 text-sm font-semibold', style.title)}>
        <Icon className="size-4 shrink-0" aria-hidden />
        {title}
      </p>
      <div className="mt-1.5 space-y-2 text-sm leading-relaxed text-fg-1">{children}</div>
    </aside>
  )
}

/** Нумерованный шаг рабочего цикла */
export function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div className="mt-4 flex max-w-3xl gap-3" data-testid={`wiki-step-${n}`}>
      <span
        aria-hidden
        className="tnum mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-accent/60 bg-accent-soft text-sm font-semibold text-fg-0"
      >
        {n}
      </span>
      <div>
        <p className="font-semibold text-fg-0">{title}</p>
        <div className="mt-1 space-y-2 text-sm leading-relaxed text-fg-1">{children}</div>
      </div>
    </div>
  )
}

/* ---------- Ссылки ---------- */

/**
 * Перекрёстная ссылка на другую статью Wiki: ведёт на хеш маршрута
 * (`/wiki#artifacts`), поэтому остаётся настоящей ссылкой и в коде, и в тестах.
 */
export function WikiLink({ to, children }: { to: WikiArticleId; children: ReactNode }) {
  const { goTo } = useWikiNav()
  return (
    <a
      href={`/wiki${wikiHash(to)}`}
      className="font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      onClick={(event) => {
        event.preventDefault()
        goTo(to)
      }}
    >
      {children}
    </a>
  )
}

/** Ссылка из статьи в рабочий раздел приложения (например, в EDF) */
export function AppLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {children}
      <ArrowRight className="size-4" aria-hidden />
    </Link>
  )
}

/**
 * Термин со словаря: подчёркнутая вставка с подсказкой-определением; клик
 * открывает глоссарий и прокручивает к якорю `term-<id>`.
 */
export function Term({ id, children }: { id: string; children?: ReactNode }) {
  const { goTo } = useWikiNav()
  const entry = glossaryEntry(id)
  if (!entry) return <>{children ?? id}</>
  return (
    <button
      type="button"
      title={entry.def}
      className="cursor-help border-b border-dotted border-fg-2 font-medium text-fg-0 hover:border-accent hover:text-accent"
      onClick={() => goTo('glossary', `term-${id}`)}
    >
      {children ?? entry.term}
    </button>
  )
}

/** Клавиша клавиатуры в тексте (`Ctrl`, `[` …) */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-bg-2 px-1.5 py-0.5 font-mono text-xs text-fg-1">
      {children}
    </kbd>
  )
}

/** Пилюля-бейдж элемента интерфейса: «кнопка шапки», «блок Эпохи» … */
export function UiRef({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-border bg-bg-2 px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-fg-1">
      {children}
    </span>
  )
}

/* ---------- Таблицы ---------- */

/** Таблица со штатной раскладкой Wiki; `head` — заголовочные ячейки */
export function WikiTable({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="mt-4 max-w-4xl overflow-x-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-bg-2 text-left text-fg-2">
            {head.map((cell, index) => (
              <th key={index} className="border-b border-border px-3 py-2 font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-fg-1">{children}</tbody>
      </table>
    </div>
  )
}

export type ParamRowSpec = {
  /** Имя параметра так, как он написан в панели */
  param: ReactNode
  /** Что делает контрол */
  what: ReactNode
  /** Как выбирать значение (необязательно) */
  tip?: ReactNode
}

/** Таблица «параметр → что делает → совет» для блоков панели опций */
export function ParamTable({ rows }: { rows: ParamRowSpec[] }) {
  return (
    <WikiTable head={['Параметр', 'Что делает', 'Как выбирать']}>
      {rows.map((row, index) => (
        <tr key={index} className="border-b border-border align-top last:border-b-0">
          <td className="px-3 py-2 font-medium whitespace-nowrap text-fg-0">{row.param}</td>
          <td className="px-3 py-2">{row.what}</td>
          <td className="px-3 py-2 text-fg-2">{row.tip ?? '—'}</td>
        </tr>
      ))}
    </WikiTable>
  )
}
