/**
 * Статья «Настройки»: раздел /settings — масштаб текста, плотность, read-only
 * параметры расчёта из /meta, локальный ресурс (GPU/CuPy + тумблер), пути
 * fsaverage/upload, модельный роутер ИИ (провайдеры, маршруты, probe).
 */
import { AppLink, ArticleTitle, Callout, H3, P, Term, Ul, WikiLink, WikiTable } from '../wikiUi'

export function SettingsArticle() {
  return (
    <>
      <ArticleTitle lead={
        <>
          Раздел «<AppLink to="/settings">Настройки</AppLink>» — интерфейс приложения
          (масштаб текста, плотность списков), параметры расчёта (только чтение —
          источник истины <code>backend/.env</code>) и локальный ресурс (автоопределение
          GPU + тумблер «Использовать GPU», источник истины — сервер).
        </>
      }>
        Настройки приложения
      </ArticleTitle>

      <H3>Интерфейс</H3>
      <WikiTable head={['Параметр', 'Значения', 'Что делает']}>
        <tr className="border-b border-border">
          <td className="px-3 py-2 font-medium text-fg-0">Масштаб текста</td>
          <td className="px-3 py-2">Обычный (16 px) / Крупный (18 px) / Очень крупный (20 px)</td>
          <td className="px-3 py-2">Базовый кегль шрифта всего приложения.</td>
        </tr>
        <tr>
          <td className="px-3 py-2 font-medium text-fg-0">Плотность</td>
          <td className="px-3 py-2">Обычная / Плотная</td>
          <td className="px-3 py-2">Стандартные отступы или больше строк на экране.</td>
        </tr>
      </WikiTable>
      <P>
        Настройки интерфейса сохраняются в localStorage и применяются мгновенно.
        Кнопка «Сбросить» возвращает значения по умолчанию.
      </P>

      <H3>Параметры расчёта (read-only)</H3>
      <P>
        Блок «Параметры расчёта» показывает текущие значения из конфигурации сервера
        (<code>/meta</code>):
      </P>
      <Ul>
        <li>диапазоны частот (Гц) — <Term id="band">freq_bands</Term>;</li>
        <li>длины эпох (мс);</li>
        <li>decim фитинга;</li>
        <li>max эпох;</li>
        <li>z-порог артефактов и окно z-score (с);</li>
        <li>peak-to-peak порог (мкВ);</li>
        <li>параллельных задач (max_concurrent_jobs).</li>
      </Ul>
      <Callout tone="info" title="Только чтение">
        <p>
          Эти параметры — источник истины <code>backend/.env</code>. Правка — через
          конфигурацию сервера, не через UI.
        </p>
      </Callout>

      <H3>Локальный ресурс (GPU)</H3>
      <P>
        Блок «Локальный ресурс» — автоопределение GPU и тумблер «Использовать GPU (CUDA)»:
      </P>
      <Ul>
        <li>
          <b>Видеокарта</b> — имя GPU (или «не найдена»);
        </li>
        <li>
          <b>Память GPU, МБ</b> — доступная видеопамять;
        </li>
        <li>
          <b>CuPy</b> — «установлен» / «не установлен»;
        </li>
        <li>
          <b>MNE CUDA</b> — «доступна» / «недоступна».
        </li>
      </Ul>
      <P>
        Тумблер «Использовать GPU (CUDA)» — источник истины сервер (MNE-конфиг,{' '}
        <code>backend/app/services/gpu.py</code>). Включение требует CuPy и доступной
        CUDA; если что-то из этого отсутствует — тумблер выключен с причиной.
      </P>

      <H3>Пути данных</H3>
      <P>
        Блок «Пути» показывает серверные директории:
      </P>
      <Ul>
        <li>
          <b>subjects_dir</b> — каталог FreeSurfer (fsaverage, BEM);
        </li>
        <li>
          <b>trans</b> — файл трансформации head → MNI;
        </li>
        <li>
          <b>upload_dir</b> — каталог загруженных EDF.
        </li>
      </Ul>

      <H3>Модельный роутер ИИ</H3>
      <P>
        Панель «Модельный роутер ИИ» — провайдеры внешних API полноценных моделей
        и маршруты <Term id="llm-router">chat/transcribe/decide</Term>. Правила:
      </P>
      <Ul>
        <li>
          правка формы ничего не отправляет наружу (считает только кнопка «Сохранить»);
        </li>
        <li>
          ключ вводится один раз и не возвращается сервером (только маска{' '}
          <code>key_hint</code>);
        </li>
        <li>
          «Проверить связь» (probe) шлёт нейтральный запрос без материалов дела;
        </li>
        <li>
          «Проба советника» (chat-probe) — синтетический сценарий на выбранном провайдере;
        </li>
        <li>
          «Проба Jev» (decide-probe) — проба решающего классификатора.
        </li>
      </Ul>
      <Callout tone="warn" title="Приватность">
        <p>
          Материалы дела не отправляются при probe/chat-probe/decide-probe. Что уходит
          провайдеру при раундах советников — сжатый дайджест снимка; контекст только
          с флагом <code>use_with_advisers</code>. Подробности — в{' '}
          <WikiLink to="consilium">«Консилиуме»</WikiLink>.
        </p>
      </Callout>

      <Callout tone="tip" title="Связанные разделы">
        <Ul>
          <li>
            <AppLink to="/server">«Состояние сервера»</AppLink> — готовность MNE, БД,
            fsaverage, BEM; перезапуск бэкенда.
          </li>
          <li>
            <WikiLink to="consilium">«Консилиум»</WikiLink> — где используются советники.
          </li>
        </Ul>
      </Callout>
    </>
  )
}
