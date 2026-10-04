/**
 * Раздел «Wiki»: пользовательское руководство по препроцессингу EDF.
 *
 * Статьи — статичные компоненты без запросов; активная статья и якорь живут
 * в хеше маршрута (`/wiki#artifacts`, `/wiki#glossary/term-ica`) — это даёт
 * пермалинки и бесплатные «назад/вперёд» браузера. Навигация внутри
 * статей (`WikiLink`, `Term`) ходит через `WikiNavContext`.
 */
import { useCallback, useEffect, useMemo, type ComponentType } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { cx } from '@/shared/ui/cx'
import { Button } from '@/shared/ui/Button'
import { ArtifactsArticle } from './articles/ArtifactsArticle'
import { CleanArticle } from './articles/CleanArticle'
import { CompareArticle } from './articles/CompareArticle'
import { DipoleCalcArticle } from './articles/DipoleCalcArticle'
import { DipolePlaybackArticle } from './articles/DipolePlaybackArticle'
import { DipolesOverviewArticle } from './articles/DipolesOverviewArticle'
import { EegScreenArticle } from './articles/EegScreenArticle'
import { EloretaArticle } from './articles/EloretaArticle'
import { EpochsArticle } from './articles/EpochsArticle'
import { FilterArticle } from './articles/FilterArticle'
import { GlossaryArticle } from './articles/GlossaryArticle'
import { GroupAnalysisArticle } from './articles/GroupAnalysisArticle'
import { IntroArticle } from './articles/IntroArticle'
import { OpenArticle } from './articles/OpenArticle'
import { ScreenArticle } from './articles/ScreenArticle'
import { SessionExportArticle } from './articles/SessionExportArticle'
import { SummaryEventsArticle } from './articles/SummaryEventsArticle'
import { SummaryReportArticle } from './articles/SummaryReportArticle'
import { SummaryCompareReportArticle } from './articles/SummaryCompareReportArticle'
import { SummaryGroupReportArticle } from './articles/SummaryGroupReportArticle'
import {
  adjacentArticle,
  parseWikiHash,
  WIKI_ARTICLES,
  WikiNavContext,
  wikiHash,
  type WikiArticleId,
  type WikiNavValue,
} from './wikiNav'

const ARTICLE_COMPONENTS: Record<WikiArticleId, ComponentType> = {
  intro: IntroArticle,
  open: OpenArticle,
  screen: ScreenArticle,
  filter: FilterArticle,
  artifacts: ArtifactsArticle,
  clean: CleanArticle,
  epochs: EpochsArticle,
  dipoles: DipolesOverviewArticle,
  'dipole-calc': DipoleCalcArticle,
  'dipole-playback': DipolePlaybackArticle,
  eloreta: EloretaArticle,
  'eeg-screen': EegScreenArticle,
  'summary-report': SummaryReportArticle,
  'summary-events': SummaryEventsArticle,
  compare: CompareArticle,
  'group-analysis': GroupAnalysisArticle,
  'summary-compare-report': SummaryCompareReportArticle,
  'summary-group-report': SummaryGroupReportArticle,
  export: SessionExportArticle,
  glossary: GlossaryArticle,
}

export function WikiSection() {
  const location = useLocation()
  const navigate = useNavigate()
  const { article, anchor } = parseWikiHash(location.hash)
  // Неизвестный или пустой хеш — открываем первую статью (пермалинк цел)
  const active: WikiArticleId = article ?? 'intro'

  const goTo = useCallback(
    (id: WikiArticleId, target?: string) => {
      navigate({ pathname: '/wiki', hash: wikiHash(id, target) })
    },
    [navigate],
  )

  const nav = useMemo<WikiNavValue>(() => ({ active, goTo }), [active, goTo])

  // Прокрутка: к якорю внутри статьи либо к её началу. `scrollIntoView`
  // бережём от jsdom (там его нет — паттерн `LocalizationTable`/`RightPanel`).
  useEffect(() => {
    const target = anchor
      ? document.getElementById(anchor)
      : document.getElementById('wiki-article')
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'start' })
    }
  }, [active, anchor])

  const Current = ARTICLE_COMPONENTS[active]
  const activeIndex = WIKI_ARTICLES.findIndex((item) => item.id === active)
  const prev = adjacentArticle(active, -1)
  const next = adjacentArticle(active, 1)

  return (
    <WikiNavContext.Provider value={nav}>
      <div className="grid min-h-full grid-cols-[15rem_minmax(0,1fr)]">
        <nav
          aria-label="Оглавление Wiki"
          className="sticky top-0 h-fit max-h-screen overflow-y-auto border-r border-border bg-bg-1 p-3"
        >
          <p className="px-2 pb-2 text-xs font-semibold tracking-wide text-fg-2 uppercase">
            Руководство · {activeIndex + 1} из {WIKI_ARTICLES.length}
          </p>
          <ul className="space-y-1">
            {WIKI_ARTICLES.map((item) => {
              const Icon = item.icon
              const current = item.id === active
              return (
                <li key={item.id}>
                  <a
                    href={`/wiki${wikiHash(item.id)}`}
                    title={item.hint}
                    aria-current={current ? 'page' : undefined}
                    className={cx(
                      'flex items-center gap-2 rounded-lg border px-2 py-1.5 text-sm transition-colors',
                      current
                        ? 'border-accent/60 bg-accent-soft text-fg-0'
                        : 'border-transparent text-fg-1 hover:bg-bg-3 hover:text-fg-0',
                    )}
                    onClick={(event) => {
                      event.preventDefault()
                      goTo(item.id)
                    }}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden />
                    {item.short}
                  </a>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="min-w-0 p-6 pb-16">
          <article id="wiki-article" key={active} data-article={active}>
            <Current />
          </article>

          <footer className="mt-10 flex max-w-3xl items-center justify-between gap-4 border-t border-border pt-4">
            {prev ? (
              <Button
                variant="ghost"
                icon={<ArrowLeft className="size-4" />}
                onClick={() => goTo(prev.id)}
              >
                {prev.short}
              </Button>
            ) : (
              <span />
            )}
            {next ? (
              <Button
                variant="ghost"
                icon={<ArrowRight className="size-4" />}
                onClick={() => goTo(next.id)}
              >
                {next.short}
              </Button>
            ) : (
              <span />
            )}
          </footer>
        </div>
      </div>
    </WikiNavContext.Provider>
  )
}