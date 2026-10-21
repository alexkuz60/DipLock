/**
 * Выдвижная панель раздела «Диполи» (срез 3.4; правка 20.10.2026): топокарты
 * ритмов (все полосы каталога, 2 ряда) и АЧХ-график (средняя мощность ритмов +
 * PSD по частотам) — **двумя панелями** с кнопками в шапке. График вернулся на
 * собственную панель после неудачного слияния с топокартами: в общей панели он
 * схлопывался по высоте до ~10 px; теперь его высота фиксированная ~300 px, а
 * ширина — во всю панель (`FftHistogram` меряет ширину контейнера, как
 * `TrackStack`).
 *
 * Живёт **окном поверх рабочей области** (проп `drawer` у `AppShell`): панель
 * перекрывает рабочий вид 3-х проекций сверху и тянется до нижнего края рабочей
 * области, а не отодвигает проекции вниз — геометрия фигур не пересчитывается
 * при открытии/закрытии (меньше отрисовки). Это обзорный слой «по записи», а не
 * часть проекций: проекции остаются смонтированными под панелью, расчёт можно
 * не терять. Открыта не более одной панели за раз (`view` в сторе расчёта).
 *
 * Спектр считается **только кнопкой** (правило раздела): панель показывает
 * результат, а кнопка «Рассчитать спектр» ставит задачу `POST …/spectrum` и
 * показывает её прогресс по этапам и эпохам. Правка параметров (длина эпохи,
 * порог reject, метод PSD) ничего не запускает и **не пересчитывает** уже
 * показанный спектр: он относится к своим параметрам (показываем их в подписи),
 * а новый расчёт — снова по кнопке. Метод PSD (Welch/Multitaper) продублирован
 * на панели из сайдбара «Опции» — рядом с кнопкой расчёта, чтобы не искать его
 * в другом месте экрана.
 *
 * Картинка топокарты собирается из **результата** (`spectrumQueryOf`): полоса,
 * notch, длина эпохи и метод PSD уходят в URL, потому что по ним сервер
 * считает ETag. Иначе после смены фильтра браузер показал бы картинку прошлого
 * расчёта рядом с числами нового.
 *
 * Окно частот АЧХ-графика (срез 3.5) — параметр просмотра: панель передаёт его в
 * `FftHistogram` из состояния расчёта, и правка окна **ничего не запрашивает**.
 */
import {
  AudioWaveform,
  Loader2,
  X,
} from 'lucide-react'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { spectrumMetrics, spectrumQueryOf, spectrumSummary } from '@/shared/lib/spectrum'
import { CancelJobButton } from '@/shared/ui/CancelJobButton'
import { IconButton } from '@/shared/ui/IconButton'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { StatusPill } from '@/shared/ui/StatusPill'
import { BandTopomaps } from './BandTopomaps'
import { ExploreTable } from './ExploreTable'
import { FftHistogram } from './FftHistogram'

const TITLES = {
  topomap: 'Топокарты ритмов',
  fft: 'FFT-гистограмма по диапазонам',
  explore: 'Разведочный спектральный проход',
} as const

const HINTS = {
  topomap:
    'Распределение мощности ритма по скальпу: картинку строит сервер (PNG), вне круга головы она прозрачна. Светлее — сильнее мощность; белые точки — датчики монтажа: залитый круг — канал записи, окружность — электрод без канала в записи. Полоса фильтра берётся из формы панели «Расчёт диполей».',
  fft: 'Средняя мощность каждого ритма плюс PSD по частотам: по ним видно, на каком ритме сосредоточена энергия записи. Окно частот сужает график (кнопки ритмов или поля «от/до») — это просмотр уже посчитанных чисел, а не новый расчёт. Полоса самого расчёта задаётся фильтром в панели «Расчёт диполей».',
  explore:
    'Список отдельных частот с мощностью, плотностью и амплитудным диапазоном по эпохам в долях от «полки» своей полосы — вход для выбора узких поддиапазонов «Пакета поддиапазонов». Таблица показывает измерения: полосы выбирает исследователь, а не таблица.',
} as const

export function DipolesDrawer() {
  const view = useDipoleCalc((state) => state.view)
  const spectrum = useDipoleCalc((state) => state.spectrum)
  const spectrumJob = useDipoleCalc((state) => state.spectrumJob)
  const spectrumError = useDipoleCalc((state) => state.spectrumError)
  const runSpectrum = useDipoleCalc((state) => state.runSpectrum)
  const cancelSpectrum = useDipoleCalc((state) => state.cancelSpectrum)
  const setView = useDipoleCalc((state) => state.setView)
  const fftRangeHz = useDipoleCalc((state) => state.fftRangeHz)
  const setFftRange = useDipoleCalc((state) => state.setFftRange)
  // Метод PSD — дубль из сайдбара «Опции»: правка ничего не запускает (правило
  // раздела), но делает следующий расчёт спектра своим методом
  const psdMethod = useDipoleCalc((state) => state.params.psdMethod)
  const setPsdMethod = useDipoleCalc((state) => state.setPsdMethod)
  const recording = useEdfRecording((state) => state.recording)

  if (view === 'none') return null

  const running = spectrumJob?.status === 'running'

  return (
    <section
      aria-label={TITLES[view]}
      data-testid="dipoles-drawer"
      data-view={view}
      className="absolute inset-0 z-10 flex flex-col overflow-y-auto bg-bg-1 px-4 py-3"
    >
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-base font-semibold text-fg-0">{TITLES[view]}</h2>
        {spectrum ? (
          <StatusPill tone="accent">{spectrumSummary(spectrum)}</StatusPill>
        ) : (
          <StatusPill tone="neutral">Спектр не рассчитан</StatusPill>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* Метод PSD — рядом с кнопкой расчёта (дубль сайдбара «Опции») */}
          <SegmentedControl
            label="Метод PSD"
            layout="inline"
            value={psdMethod}
            options={[
              {
                value: 'welch',
                label: 'Welch',
                title: 'Привычная оценка окном n_fft: хороша для эпох длиннее секунды',
              },
              {
                value: 'multitaper',
                label: 'Multitaper',
                title: 'DPSS на всей эпохе: для коротких эпох (250–500 мс) даёт честное разрешение',
              },
            ]}
            onChange={setPsdMethod}
          />
          <IconButton
            icon={
              running ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <AudioWaveform className="size-5" />
              )
            }
            label={spectrum ? 'Пересчитать спектр' : 'Рассчитать спектр'}
            tooltip={
              recording === null
                ? 'Сначала загрузите EDF в разделе EDF — спектр считается по файлу записи'
                : `Запустить расчёт спектра по диапазонам (PSD ${psdMethod === 'multitaper' ? 'multitaper' : 'Welch'} + топокарты)`
            }
            title={
              recording === null
                ? 'Сначала загрузите EDF в разделе EDF — спектр считается по файлу записи'
                : `Запустить расчёт спектра по диапазонам (PSD ${psdMethod === 'multitaper' ? 'multitaper' : 'Welch'} + топокарты)`
            }
            disabled={recording === null || running}
            onClick={() => void runSpectrum(recording?.recording_id ?? null)}
          />
          <IconButton
            icon={<X className="size-5" />}
            tooltip="Закрыть панель"
            label="Закрыть выдвижную панель"
            onClick={() => setView('none')}
          />
        </div>
      </div>

      {running ? (
        <div className="flex items-center gap-2">
          <LoadingBlock
            label={`Спектр: ${spectrumJob?.message || spectrumJob?.stage} — ${Math.round((spectrumJob?.progress ?? 0) * 100)} %`}
          />
          <CancelJobButton onCancel={cancelSpectrum} />
        </div>
      ) : spectrumError && spectrum === null ? (
        <ErrorBlock title="Спектр не рассчитан" message={spectrumError} />
      ) : spectrum === null ? (
        <p className="text-sm text-fg-2">
          Спектр не рассчитан: нажмите «Рассчитать спектр» — задача прочитает запись, нарежет эпохи
          и посчитает Welch PSD по ритмам. Правка параметров расчёт не запускает.
        </p>
      ) : (
        <>
          {/* Ошибка пересчёта не прячется за прежним результатом: числа и картинки
              остались от прошлого запуска, и об этом нужно сказать явно */}
          {spectrumError ? (
            <p className="mb-2 text-sm text-warn">
              {`Показан прежний расчёт: последний запуск завершился ошибкой — ${spectrumError}`}
            </p>
          ) : null}
          <p className="mb-2 text-sm text-fg-2">{HINTS[view]}</p>
          {spectrumMetrics(spectrum).length > 0 ? (
            <p className="mb-2 text-sm text-fg-1" data-testid="spectrum-metrics">
              {spectrumMetrics(spectrum).join(' · ')}
            </p>
          ) : null}
          {spectrum.missed_channels && spectrum.missed_channels.length > 0 ? (
            <p className="mb-2 text-sm text-warn">
              {`Без позиции в монтаже (в топокарты не попали): ${spectrum.missed_channels.join(', ')}`}
            </p>
          ) : null}
          {view === 'topomap' ? (
            /* Топокарты ритмов — ровно два ряда (правка 20.10.2026): картинки
               не уменьшаются, панель растёт по высоте */
            <BandTopomaps spectrum={spectrum} query={spectrumQueryOf(spectrum)} />
          ) : view === 'fft' ? (
            /* АЧХ-гистограмма — собственная панель (правка 20.10.2026 вернула
               её после слияния: в общей панели график схлопывался по высоте до
               ~10 px); высота графика фиксированная ~300 px, ширина — во всю
               панель (меряется по контейнеру, как в `TrackStack`) */
            <FftHistogram
              spectrum={spectrum}
              range={fftRangeHz ?? null}
              onRangeChange={setFftRange}
            />
          ) : spectrum.explore ? (
            <ExploreTable explore={spectrum.explore} className="min-h-0 flex-1" />
          ) : (
            // Результат задачи мог быть записан прошлой версией кода (без
            // `explore`) — честное «не входит», а не пустая таблица
            <p className="text-sm text-fg-2" data-testid="explore-missing">
              Разведочный проход не входит в этот расчёт: пересчитайте спектр —
              результат посчитан прошлой версией кода.
            </p>
          )}
        </>
      )}
    </section>
  )
}
