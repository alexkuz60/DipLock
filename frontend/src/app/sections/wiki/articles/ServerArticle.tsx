/**
 * Статья «Состояние сервера»: раздел /server — готовность MNE/БД/fsaverage/BEM,
 * версии библиотек, пути данных, поллинг 5 с, code.stale, перезапуск бэкенда.
 */
import { AppLink, ArticleTitle, Callout, H3, P, Ul, WikiLink, WikiTable } from '../wikiUi'

export function ServerArticle() {
  return (
    <>
      <ArticleTitle lead={
        <>
          Раздел «<AppLink to="/server">Состояние сервера</AppLink>» — диагностика
          готовности приложения: проверки MNE, БД, fsaverage, transform, BEM, версии
          библиотек, пути данных, активные параметры расчёта и кнопка перезапуска
          бэкенда. Поллинг — 5 с и только пока открыта вкладка.
        </>
      }>
        Состояние сервера
      </ArticleTitle>

      <H3>Проверки готовности</H3>
      <P>
        Блок «Проверки» показывает статус пяти компонентов:
      </P>
      <WikiTable head={['Компонент', 'Что проверяется', 'Статусы']}>
        <tr className="border-b border-border">
          <td className="px-3 py-2 font-medium text-fg-0">MNE</td>
          <td className="px-3 py-2">Версия библиотеки MNE-Python.</td>
          <td className="px-3 py-2">готово / ожидание / загрузка / ошибка / неизвестно</td>
        </tr>
        <tr className="border-b border-border">
          <td className="px-3 py-2 font-medium text-fg-0">База данных</td>
          <td className="px-3 py-2">Движок SQLite/PostgreSQL, миграции alembic.</td>
          <td className="px-3 py-2">готово / ожидание / загрузка / ошибка / неизвестно</td>
        </tr>
        <tr className="border-b border-border">
          <td className="px-3 py-2 font-medium text-fg-0">fsaverage</td>
          <td className="px-3 py-2">Каталог FreeSurfer subjects_dir, том T1.</td>
          <td className="px-3 py-2">готово / ожидание / загрузка / ошибка / неизвестно</td>
        </tr>
        <tr className="border-b border-border">
          <td className="px-3 py-2 font-medium text-fg-0">Transform</td>
          <td className="px-3 py-2">Файл трансформации head → MNI (trans).</td>
          <td className="px-3 py-2">готово / ожидание / загрузка / ошибка / неизвестно</td>
        </tr>
        <tr>
          <td className="px-3 py-2 font-medium text-fg-0">BEM</td>
          <td className="px-3 py-2">Boundary Element Model (поверхностный меш).</td>
          <td className="px-3 py-2">готово / ожидание / загрузка / ошибка / неизвестно</td>
        </tr>
      </WikiTable>
      <P>
        Статусы: <b>готово</b> (зелёная точка), <b>ожидание</b> (серая), <b>загрузка</b>{' '}
        (синяя), <b>ошибка</b> (красная), <b>неизвестно</b> (серая). Кнопка «Проверить
        сейчас» — принудительное обновление.
      </P>

      <H3>Версии и пути</H3>
      <P>
        Блок «Версии» показывает версии библиотек (MNE, Python, Node.js, React и др.).
        Блок «Пути» — серверные директории (subjects_dir, trans, upload_dir) — те же,
        что в разделе «<WikiLink to="settings">Настройки</WikiLink>».
      </P>

      <H3>Параметры расчёта</H3>
      <P>
        Блок «Параметры расчёта» — активные значения из <code>/meta</code>: диапазоны
        частот, длины эпох, пороги артефактов, max эпох, параллельных задач. Те же,
        что в «Настройках» (read-only).
      </P>

      <H3>Код бэкенда и устаревший процесс</H3>
      <P>
        Блок «Код бэкенда» показывает <code>server_started_at</code> — время запуска
        текущего процесса. Если код изменился после запуска (например, после{' '}
        <code>git pull</code> или правки файлов), появляется признак{' '}
        <b>«Код устарел»</b> (<code>code.stale = true</code>).
      </P>
      <Callout tone="warn" title="Устаревший процесс — частая ловушка">
        <p>
          Если <code>init-status.code.stale = true</code> — бэкенд работает на старом
          коде, и новые правки не видны в API. Лечение: кнопка «Перезапустить бэкенд»
          (см. ниже) + пересчёт записи (файлы задач и результаты стадий переживают
          перезапуск и показывают старые числа — случай 24.09.2026).
        </p>
      </Callout>

      <H3>Перезапуск бэкенда</H3>
      <P>
        Кнопка «Перезапустить бэкенд» (блок «API и UI») — 202 → exec через ~0.5 с.
        Во время перезапуска поллинг ускоряется до 1.5 с, а раздел считает его
        завершённым, когда <code>code.server_started_at</code> в <code>/init-status</code>{' '}
        разошёлся с зафиксированным перед перезапуском значением.
      </P>
      <P>
        Guard'ы перезапуска:
      </P>
      <Ul>
        <li>
          только режим лаунчера (по <code>settings.server_pid_file</code>);
        </li>
        <li>
          <code>--reload</code> → 409 (uvicorn сам следит за кодом);
        </li>
        <li>
          активные задачи → 409 (с текстом «N задач в работе»).
        </li>
      </Ul>
      <P>
        Таймаут ожидания нового процесса — 60 с. Если процесс не поднялся — ошибка
        с текстом.
      </P>

      <H3>Занятость кэша</H3>
      <P>
        Блок «Кэш» показывает занятость дискового кэша (МБ) и квоту{' '}
        <code>CACHE_QUOTA_MB</code>. Если поле <code>cache</code> отсутствует в ответе
        <code>/init-status</code> (бэкенд запущен до N40) — строка честно просит
        перезапустить сервер, а не падает.
      </P>

      <Callout tone="tip" title="Связанные разделы">
        <Ul>
          <li>
            <AppLink to="/settings">«Настройки»</AppLink> — масштаб текста, плотность,
            GPU, модельный роутер ИИ.
          </li>
          <li>
            <WikiLink to="glossary">Глоссарий</WikiLink>.
          </li>
        </Ul>
      </Callout>
    </>
  )
}
