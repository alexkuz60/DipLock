/**
 * Статья «Глоссарий»: словарь терминов из `glossary.ts` по группам.
 *
 * Каждой записи соответствует якорь `term-<id>` — на него ведёт клик по
 * термину (`<Term>`) в любой статье.
 */
import { GLOSSARY_GROUPS, glossaryByGroup } from '../glossary'
import { H3, P, WikiLink } from '../wikiUi'

export function GlossaryArticle() {
  return (
    <>
      <header className="border-b border-border pb-4">
        <h2 className="text-2xl font-bold text-fg-0">Глоссарий</h2>
        <p className="mt-2 max-w-3xl text-base text-fg-1">
          Термины, встречающиеся в руководстве и в интерфейсе. Клик по подчёркнутому термину в
          любой статье открывает эту страницу и прокручивает к определению.
        </p>
      </header>

      {GLOSSARY_GROUPS.map((group) => (
        <section key={group}>
          <H3>{group}</H3>
          <dl className="mt-3 max-w-3xl space-y-3">
            {glossaryByGroup(group).map((entry) => (
              <div key={entry.id} id={`term-${entry.id}`} className="scroll-mt-4">
                <dt className="font-semibold text-fg-0">{entry.term}</dt>
                <dd className="mt-0.5 leading-relaxed text-fg-1">{entry.def}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}

      <H3>Как это работает</H3>
      <P>
        Определения пишутся по правилам документации проекта: коротко, со ссылкой на то, где
        термин встречается в интерфейсе. Не нашли слово? Вернитесь к{' '}
        <WikiLink to="intro">Введению</WikiLink> — структура руководства повторяет рабочий цикл
        раздела EDF.
      </P>
    </>
  )
}