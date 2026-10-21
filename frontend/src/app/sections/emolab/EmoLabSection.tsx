/**
 * Раздел «ЕмоЛаб» (шаг 1, 20.10.2026): прогноз эмоциональной реакции мозга
 * на прослушиваемый аудиотрек.
 *
 * Постановка: внешний аудиофайл (wav/mp3) открывается кнопкой «Открыть аудио»
 * (тулс-хедер), проигрывается трекером (`EmoLabTracker`: пирамида превью,
 * волна-бабочка, зум, плеер ×1), а его данные собираются на сервере теми же
 * блоками «Нейромузыки» — быстрый ФФТ (кадры «Эмо») и VAMP-карты темпа и
 * аккордов (Соник Аннотатор). На основании данных рисуется та же 7-лучевая
 * звезда-полигон (`RadialChart` из «Нейромузыки»): вращение по аккордам,
 * темп-коррекция лучей, счётчики «Аккорд»/«Темп» (`EmoCounters`). Правка
 * владельца 21.10.2026: радар включает пропы «ЕмоЛаб» — гамма полос
 * «Диполей» на дугах секторов/вершинах (`bandColors`), динамический диапазон
 * шкалы лучей (`dbRangeDb` панели «Опции») и выкл/вкл значений темпа при
 * расчёте лучей (`tempoRays`); «Нейромузыка» рисует радар прежним (дефолты
 * пропов — её поведение). Под радаром — «Эмограмма» (`Emogram.tsx`): лучи
 * звезды, развернутые по шкале времени (столбики «Экспрессии Эмо» и ступени
 * «Динамики Эмо», шкала Y «Эмо» из 14 эмоций + курсор позиции плеера).
 *
 * Задел на будущее: собранные из аудио данные сравниваются с записанной
 * ЭЭГ-сессией прослушивания этого аудио (отдельная задача; шаг 2 — моно
 * 32000 Гц, кадр звезды = 1 с, VAMP-карты на моно-файле — `docs/rules/emolab.md`).
 */
import { Smile } from 'lucide-react'
import { useEmoLab, type EmoVizTab } from '@/shared/state/emolab'
import { Placeholder } from '@/shared/ui/Placeholder'
import { SegmentedControl, type SegmentedOption } from '@/shared/ui/SegmentedControl'
import { EmoCounters } from '../neuromusic/EmoCounters'
import { RadialChart } from '../neuromusic/RadialChart'
import { Emogram } from './Emogram'
import { EmoLabTracker } from './EmoLabTracker'

/**
 * Табы секции «Визуализация»: каждый график — свой таб, чтобы звезда-полигон
 * не мельчал под вторым графиком; новые аналитические графики добавляются
 * сюда же (постановка владельца 21.10.2026).
 */
const VIZ_TABS: SegmentedOption<EmoVizTab>[] = [
  { value: 'star', label: 'Звезда', title: 'Звезда-полигон «Эмо»: лучи, облако и суммарная доминанта' },
  { value: 'emogram', label: 'Эмограмма', title: 'Лучи звезды по шкале времени: экспрессия и динамика эмо' },
]

export function EmoLabSection() {
  const filename = useEmoLab((state) => state.filename)
  const busy = useEmoLab((state) => state.busy)
  const status = useEmoLab((state) => state.status)
  const error = useEmoLab((state) => state.error)
  const emo = useEmoLab((state) => state.emo)
  const dbRangeDb = useEmoLab((state) => state.dbRangeDb)
  const tempoRays = useEmoLab((state) => state.tempoRays)
  const vizTab = useEmoLab((state) => state.vizTab)
  const setVizTab = useEmoLab((state) => state.setVizTab)

  if (!filename) {
    return (
      <Placeholder
        icon={<Smile className="size-12" />}
        title="ЕмоЛаб — прогноз эмоциональной реакции"
        description="Анализ внешнего аудиотрека: волна-бабочка и плеер, ФФТ-кадры «Эмо», карты темпа и аккордов (Соник Аннотатор) и звезда-полигон реакции."
      >
        <p className="text-sm text-fg-2">
          Откройте аудиотрек (wav/mp3) кнопкой «Открыть аудио» в шапке раздела: трек
          проиграется в плеере (скорость ×1), а его данные соберутся для прогноза
          эмоциональной реакции на прослушивание. Паспорт трека и параметры анализа —
          в панели «Опции раздела» справа.
        </p>
      </Placeholder>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          {error}
        </p>
      )}

      {busy && (
        <section
          aria-label="Прогресс анализа"
          className="flex flex-col items-center gap-2 rounded-xl border border-border bg-bg-2 p-6 text-center"
        >
          <p className="text-sm text-fg-1">{status?.stage ?? 'Загрузка трека…'}</p>
          <div
            role="progressbar"
            aria-label="Прогресс анализа аудиотрека"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((status?.pct ?? 0) * 100)}
            className="h-2 w-full max-w-xl overflow-hidden rounded-full bg-bg-3"
          >
            <span
              className="block h-full rounded-full bg-accent transition-[width]"
              style={{ width: `${Math.round((status?.pct ?? 0) * 100)}%` }}
            />
          </div>
          <p className="text-xs text-fg-2">{status?.message ?? ''}</p>
        </section>
      )}

      {status?.status === 'failed' && !error && (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          Анализ не удался: {status.error ?? 'причина неизвестна'}
        </p>
      )}

      {/* Трекер: линейка + волна-бабочка (пирамида превью, зум) + позиционер;
          поверх волны — вертикали смены аккордов и ступени темпа. Плеер
          играет локальный файл (blob URL), транспорт — в тулс-хедере. */}
      <section aria-label="Прослушивание" className="flex shrink-0 flex-col gap-3">
        <EmoLabTracker emo={emo} />
      </section>

      {/* Визуализация под трекером: графики разделены по табам («Звезда» /
          «Эмограмма» / дальше), каждый занимает всю высоту секции — звезда
          не мельчает под вторым графиком. «Звезда» — звезда-полигон «Эмо»
          (кадры ФФТ + вращение по аккордам + темп-коррекция лучей) и пиули
          «Аккорд»/«Темп» — компоненты «Нейромузыки» (пропы «ЕмоЛаб»: гамма
          полос на дугах секторов/вершинах, динамический диапазон и чекбокс
          темпа). «Эмограмма» — лучи звезды по шкале времени (столбики
          «Экспрессии Эмо» и ступени «Динамики Эмо» + курсор позиции плеера).
          Активный таб живёт в сторе `emolab.ts` (переживает уход из раздела). */}
      <section
        aria-label="Визуализация"
        data-testid="emolab-visualization"
        className="flex min-h-0 flex-1 flex-col gap-2 rounded-xl border border-border bg-bg-2 p-2"
      >
        <SegmentedControl
          label="График"
          layout="inline"
          value={vizTab}
          onChange={setVizTab}
          options={VIZ_TABS}
        />
        {vizTab === 'star' ? (
          <div className="flex min-h-0 flex-1">
            <div className="min-w-0 flex-1">
              <RadialChart emo={emo} dbRangeDb={dbRangeDb} tempoRays={tempoRays} bandColors />
            </div>
            <EmoCounters emo={emo} />
          </div>
        ) : (
          <Emogram emo={emo} dbRangeDb={dbRangeDb} tempoRays={tempoRays} />
        )}
      </section>
    </div>
  )
}