/**
 * Выдвижная панель раздела «Диполи» (срез 3.4): топокарты ритмов и FFT-гистограмма.
 *
 * Живёт **между тулс-хедером и рабочей областью** (проп `drawer` у `AppShell`):
 * это обзорный слой «по записи», а не часть проекций — проекции остаются на
 * экране, а панель можно закрыть, не теряя расчёт. Открыта не более одной
 * панели за раз (`view` в сторе расчёта).
 *
 * Спектр считается **только кнопкой** (правило раздела): панель показывает
 * результат, а кнопка «Рассчитать спектр» ставит задачу `POST …/spectrum` и
 * показывает её прогресс по этапам и эпохам. Правка параметров (длина эпохи,
 * порог reject в панели опций) ничего не запускает и **не пересчитывает** уже
 * показанный спектр: он относится к своим параметрам (показываем их в подписи),
 * а новый расчёт — снова по кнопке.
 *
 * Картинка топокарты собирается из **результата** (`spectrumQueryOf`): полоса,
 * notch, длина эпохи и порог reject уходят в URL, потому что по ним сервер
 * считает ETag. Иначе после смены фильтра браузер показал бы картинку прошлого
 * расчёта рядом с числами нового.
 *
 * Окно частот FFT-графика (срез 3.5) — параметр просмотра: панель передаёт его в
 * `FftHistogram` из состояния расчёта, и правка окна **ничего не запрашивает**.
 */
import { X } from 'lucide-react'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { spectrumQueryOf, spectrumSummary } from '@/shared/lib/spectrum'
import { Button } from '@/shared/ui/Button'
import { IconButton } from '@/shared/ui/IconButton'
import { ErrorBlock, LoadingBlock } from '@/shared/ui/StateViews'
import { StatusPill } from '@/shared/ui/StatusPill'
import { BandTopomaps } from './BandTopomaps'
import { FftHistogram } from './FftHistogram'

const TITLES = {
  topomap: 'Топокарты ритмов',
  fft: 'FFT-гистограмма по диапазонам',
} as const

const HINTS = {
  topomap:
    'Распределение мощности ритма по скальпу: картинку строит сервер (PNG), вне круга головы она прозрачна. Светлее — меньше мощность. Полоса фильтра берётся из формы панели «Расчёт диполей».',
  fft: 'Средняя мощность каждого ритма плюс PSD по частотам: по ним видно, на каком ритме сосредоточена энергия записи. Окно частот сужает график (кнопки ритмов или поля «от/до») — это просмотр уже посчитанных чисел, а не новый расчёт. Полоса самого расчёта задаётся фильтром в панели «Расчёт диполей».',
} as const

export function DipolesDrawer() {
  const view = useDipoleCalc((state) => state.view)
  const spectrum = useDipoleCalc((state) => state.spectrum)
  const spectrumJob = useDipoleCalc((state) => state.spectrumJob)
  const spectrumError = useDipoleCalc((state) => state.spectrumError)
  const runSpectrum = useDipoleCalc((state) => state.runSpectrum)
  const setView = useDipoleCalc((state) => state.setView)
  const fftRangeHz = useDipoleCalc((state) => state.fftRangeHz)
  const setFftRange = useDipoleCalc((state) => state.setFftRange)
  const recording = useEdfRecording((state) => state.recording)

  if (view === 'none') return null

  const running = spectrumJob?.status === 'running'

  return (
    <section
      aria-label={TITLES[view]}
      data-testid="dipoles-drawer"
      data-view={view}
      className="shrink-0 border-b border-border bg-bg-1 px-4 py-3"
    >
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-base font-semibold text-fg-0">{TITLES[view]}</h2>
        {spectrum ? (
          <StatusPill tone="accent">{spectrumSummary(spectrum)}</StatusPill>
        ) : (
          <StatusPill tone="neutral">Спектр не рассчитан</StatusPill>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="primary"
            disabled={recording === null || running}
            title={
              recording === null
                ? 'Сначала загрузите EDF в разделе EDF — спектр считается по файлу записи'
                : 'Запустить расчёт спектра по диапазонам (Welch PSD + топокарты)'
            }
            onClick={() => void runSpectrum(recording?.recording_id ?? null)}
          >
            {spectrum ? 'Пересчитать спектр' : 'Рассчитать спектр'}
          </Button>
          <IconButton
            icon={<X className="size-5" />}
            tooltip="Закрыть панель"
            label="Закрыть выдвижную панель"
            onClick={() => setView('none')}
          />
        </div>
      </div>

      {running ? (
        <LoadingBlock
          label={`Спектр: ${spectrumJob?.message || spectrumJob?.stage} — ${Math.round((spectrumJob?.progress ?? 0) * 100)} %`}
        />
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
          {spectrum.missed_channels.length > 0 ? (
            <p className="mb-2 text-sm text-warn">
              {`Без позиции в монтаже (в топокарты не попали): ${spectrum.missed_channels.join(', ')}`}
            </p>
          ) : null}
          {view === 'topomap' ? (
            <BandTopomaps spectrum={spectrum} query={spectrumQueryOf(spectrum)} />
          ) : (
            <FftHistogram
              spectrum={spectrum}
              range={fftRangeHz ?? null}
              onRangeChange={setFftRange}
            />
          )}
        </>
      )}
    </section>
  )
}
