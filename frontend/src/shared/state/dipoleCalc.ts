/**
 * Состояние раздела «Диполи» (срез 3.4 + пакетный сценарий): выделенный диполь,
 * выделенная эпоха индикатора, пороги отображения (GOF % — основной, момент нА·м —
 * дополнительный), окно частот FFT-графика, открытая выдвижная панель и результаты задач.
 *
 * Правило раздела то же, что в EDF (`docs/ui.md`): правка параметра **ничего не
 * запускает**. Расчёт стартует только кнопкой в шапке и всегда считает **пакет
 * по всем полосам каталога** (`POST /recordings/{id}/dipole_batch`): одиночный
 * расчёт по всему спектру убран — усреднённые диполи эпох по широкой полосе
 * «среднюю температуру по больнице» дают, а не локализацию ритма. Спектр —
 * отдельной кнопкой (`…/spectrum`), параметры лишь помечают, что результат устарел.
 *
 * Что здесь, а что нет (разрезка 17.09.2026):
 * - **домен** — параметры расчёта и их дефолты, рамки контролов, формы запросов,
 *   состояние фоновой задачи, отпечатки параметров и результата, а также типы
 *   состояния просмотра — в `shared/lib/dipoleCalcModel.ts` (чистый модуль: те же
 *   правила проверяются без хранилища);
 * - здесь — значения и **действия**: сеттеры формы, запуск задач с поллингом,
 *   сброс и персист. Результаты задач принадлежат записи и сбрасываются вместе с
 *   ней (закрытие записи);
 * - в компонентах — отрисовка: топокарты, гистограмма и подсветка выделенного
 *   диполя считаются из результата чистыми функциями (`shared/lib/spectrum.ts`,
 *   `shared/lib/dipolePoints.ts`).
 *
 * Полоса фильтра одиночного расчёта убрана вместе с ним (секция «Фильтр
 * расчёта» панели): пакет фильтруется своими поддиапазонами (`dipoleBatch`), в
 * форме остаются notch, длина эпохи, шаг сетки и метод PSD. Устаревшие
 * сохранённые поля формы просто игнорируются — хранить/переносить их незачем.
 * Персистится только набор параметров и предпочтений просмотра (окно частот):
 * результаты задач и выделения относятся к конкретной записи и после перезагрузки
 * страницы бессмысленны.
 *
 * Воспроизведение траектории (срез 3.7) — тоже состояние **просмотра**, но с
 * командой из шапки: `playback` хранит идущее воспроизведение, скорость,
 * номер эпохи и счётчик пользовательских переходов (`seekSeq` — как `navRequest.seq`
 * в EDF, чтобы часы не проигрывали одну команду дважды). Непрерывное время кадра
 * здесь **не** живёт: его ведут часы раздела (`PlaybackFrame.tsx`), а в стор уходит
 * только смена эпохи — кадры 60 раз в секунду не должны перерисовывать облако точек.
 * Покадровые команды «<»/«>» убраны: кадр перематывается кликом по ячейке
 * индикатора эпох (`EpochDipoleStrip`), и тот же клик выбирает пакет диполей
 * своей эпохи (`selectedEpochIndex`).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { api, apiErrorText } from '@/shared/api/client'
import {
  clamp,
  normalizeNotchHz,
} from '@/shared/lib/calcFilter'
import {
  CALC_PARAM_DEFAULTS,
  GOF_THRESHOLD_RANGE,
  GRID_MM_RANGE,
  PLAYBACK_DEFAULTS,
  THRESHOLD_NAM_RANGE,
  buildSpectrumForm,
  buildRefineForm,
  calcJobFromStatus,
  normalizeCalcParams,
  normalizeRefineHalfwin,
  type CalcJob,
  type CalcParams,
  type CalcView,
  type PlaybackState,
} from '@/shared/lib/dipoleCalcModel'
import { cancelRemoteJob, createRunToken, isCancelled, waitForJob } from '@/shared/lib/jobPolling'
import {
  buildDipoleBatchForm,
  scanResultOfBand,
} from '@/shared/lib/dipoleBatch'
import { normalizeFreqWindow, type FreqWindow } from '@/shared/lib/spectrum'
import { canPlayback, clampEpochIndex, normalizePlaybackSpeed } from '@/shared/lib/playback'
import type { DipoleBatchResult, DipoleRefineResult, DipoleScanResult, EloretaResult, SpectrumResult } from '@/shared/api/types'

/**
 * Токен запуска расчёта: новый расчёт, новый спектр или сброс делают ответы
 * прежних задач неактуальными, и они не должны трогать состояние. Механизм
 * отмены (номер попытки + проверка актуальности) — общий, `shared/lib/jobPolling.ts`.
 */
const calcRunToken = createRunToken()

export type DipoleCalcState = {
  /** Открытая выдвижная панель раздела (`none` — закрыта) */
  view: CalcView
  /**
   * Порог отображения «GOF ≥ X %» (основной контур отбора, 0 — выключен):
   * слабее по GOF — не рисуется. Параметр отображения, расчёт не меняет.
   */
  gofThresholdPercent: number
  /**
   * Дополнительный порог отображения «Момент диполя ≥ X нАм» (0 — выключен):
   * опционная фильтрация по абсолютному моменту. «КД» этот порог **не** является —
   * КД (критерий годности) живёт в `kd_passed`/`kd_basis` (С0).
   */
  amplitudeThresholdNam: number
  /**
   * Окно частот FFT-графика, Гц (`null` — весь измеренный диапазон).
   * Параметр **просмотра**: график срезает уже посчитанные числа PSD, запросов
   * не делает (правило раздела «UI не запускает обработку»).
   */
  fftRangeHz: FreqWindow | null
  /**
   * Выделенный диполь (id точки слоя) — подсвечивается во **всех** проекциях:
   * выбор в одной, синхронизация в трёх. Сессионное состояние, не персистится.
   */
  selectedPointId: string | null
  /**
   * Текущая эпоха индикатора эпох (`EpochDipoleStrip`): она же белая рамка
   * ячейки. Клик по ячейке выбирает эпоху и перематывает кадр на неё (повторный
   * клик снимает выбор); в Плей выделение **следует за кадром** анимации, и в
   * проекциях показывается **пакет диполей** текущей эпохи (точки всех
   * отображаемых полос). Номер — сетка нарезки включая BAD.
   */
  selectedEpochIndex: number | null
  /** Кадр воспроизведения траектории: играет/пауза, скорость, эпоха (срез 3.7) */
  playback: PlaybackState
  params: CalcParams
  /** Результат расчёта диполей (точки MNI) */
  result: DipoleScanResult | null
  /**
   * Прогон по набору поддиапазонов (С1): **набор** результатов одной сессии
   * (полосы + сопоставление + кластеры), а не один `result`. Правка формы
   * пакета (как и любая правка) ничего не запускает — считает кнопка.
   */
  batch: DipoleBatchResult | null
  /** Задача пакета поддиапазонов (прогресс/ошибка) */
  batchJob: CalcJob | null
  /** Текст последней ошибки расчёта (пакет — единственный расчёт диполей) */
  batchError: string | null
  /**
   * Активная полоса пакета: её точки показывают проекции, playback и таблица
   * (`result` держит скан активной полосы — прежняя отрисовка работает без правок).
   */
  activeBandKey: string | null
  /**
   * Полосы анимации и облака пакета (чекбоксы панели, п.1.4 17.10.2026):
   * отмеченные полосы рисуются **одновременно** в полосных цветах (гамма
   * red→violet) и в анимации (мультиполосный кадр), и в облаке точек. Пусто —
   * полосы не отмечены (облако и кадр пусты). Заполняется «все полосы» после
   * прогона пакета; одиночный расчёт этого состояния не использует.
   */
  playbackBandKeys: string[]
  /** Задача спектра по диапазонам */
  spectrumJob: CalcJob | null
  /** Результат спектра (диапазоны + ссылки на топокарты) */
  spectrum: SpectrumResult | null
  /**
   * Текст последней ошибки спектра — **отдельно** от ошибки расчёта: иначе
   * панель объясняла бы сбой диполей словами «спектр не рассчитан».
   */
  spectrumError: string | null
  /** Задача точного уточнения эпохи (F19, «Уточнить…» в таблице локализации) */
  refineJob: CalcJob | null
  /** Эпоха, которая уточняется прямо сейчас (с 0); `null` — уточнения нет */
  refiningEpoch: number | null
  /**
   * Уточнённые точки по номеру эпохи: «было/стало» живёт здесь, а результат
   * быстрого расчёта не переписывается — он остаётся тем, что посчитала задача.
   */
  refinedPoints: Record<number, DipoleRefineResult>
  /** Текст последней ошибки уточнения — отдельно от ошибки расчёта */
  refineError: string | null
  /**
   * Задача eLORETA (остаток B9): пик/ROI распределения одной эпохи. Окно —
   * общее с refine (`refineHalfwinMs`, один физический параметр «окно вокруг
   * пика GFP»), полные карты не отдаются (dipoles.md п.5).
   */
  eloretaJob: CalcJob | null
  /** Эпоха, которая считается eLORETA прямо сейчас (с 0); null — нет */
  eloretaEpochIndex: number | null
  /** Результаты eLORETA по номеру эпохи (как `refinedPoints`) */
  eloretaResults: Record<number, EloretaResult>
  /** Текст последней ошибки eLORETA — отдельно от ошибки расчёта */
  eloretaError: string | null
  setView: (view: CalcView) => void
  /** Открыть панель, а повторное нажатие — закрыть (кнопки тулс-хедера) */
  toggleView: (view: Exclude<CalcView, 'none'>) => void
  /** Порог отображения по GOF, % (зажимается в `GOF_THRESHOLD_RANGE`) */
  setGofThreshold: (value: number) => void
  /** Дополнительный порог отображения по моменту, нА·м (зажимается в `THRESHOLD_NAM_RANGE`) */
  setAmplitudeThreshold: (value: number) => void
  /** Окно частот FFT-графика по кнопке ритма или полю «от/до»; `null` — весь диапазон */
  setFftRange: (range: FreqWindow | null) => void
  /** Повторный клик по выделенной точке снимает выделение (одна кнопка на два состояния) */
  toggleSelectedPoint: (id: string) => void
  clearSelectedPoint: () => void
  /**
   * Выбор эпохи индикатора (клик по ячейке): пакет диполей эпохи в проекциях +
   * перемотка кадра анимации на эту эпоху. Повторный клик снимает выбор.
   */
  toggleSelectedEpoch: (epochIndex: number) => void
  clearSelectedEpoch: () => void
  /** Play/pause кадра воспроизведения: без результата ничего не запускает */
  togglePlayback: () => void
  /** Пауза без снятия кадра (конец записи, уход из раздела) */
  pausePlayback: () => void
  /** Скорость воспроизведения: значение приводится к 1/2/4 */
  setPlaybackSpeed: (speed: number) => void
  /**
   * Перевод кадра на конкретную эпоху (ставит на паузу): выделение переезжает
   * на неё же — белая рамка индикатора и пакет диполей проекций следуют за кадром.
   */
  seekPlaybackEpoch: (epochIndex: number) => void
  /**
   * Снять кадр воспроизведения: стоп + снятие выделения эпохи — облако диполей
   * возвращается в полный (обычный) вид.
   */
  clearPlaybackFrame: () => void
  /**
   * Сдвиг кадра **часами** воспроизведения (не команда: счётчик переходов не
   * растёт). Выделение следует за кадром: в Плей белая рамка индикатора едет по
   * эпохам вместе с анимацией.
   */
  setPlaybackEpoch: (epochIndex: number) => void
  setEpochLengthMs: (value: number) => void
  setGridMm: (value: number) => void
  /** Метод PSD спектра (N17): только задача спектра, диполи не пересчитываются */
  setPsdMethod: (value: 'welch' | 'multitaper') => void
  /** Сетевой фильтр 50/60 Гц (`null` — выключен) */
  setNotchHz: (value: number | null) => void
  /**
   * Прогон по всем полосам каталога (С1) по кнопке: набор результатов вместо
   * одного (`batch`), активная полоса — первая из набора; `result` становится
   * сканом активной полосы (проекции/таблица/подписи — без правок). `bandKeys` —
   * все ключи `freq_bands`/`functional_bands` из `/meta` (выбор полос в UI убран:
   * пакет всегда считает весь каталог).
   */
  runBatch: (recordingId: string | null, bandKeys: string[]) => Promise<void>
  /** Смена активной полосы пакета: `result` = скан её точек, кадр снимается */
  setActiveBand: (bandKey: string) => void
  /** Переключить полосу в анимации/облаке (чекбокс панели пакета) */
  togglePlaybackBand: (bandKey: string) => void
  /** Задать полосы анимации/облака («Все» / «Только активная») */
  setPlaybackBandKeys: (bandKeys: string[]) => void
  /** Расчёт спектра по кнопке: числа PSD + топокарты диапазонов */
  runSpectrum: (recordingId: string | null) => Promise<void>
  /** Отмена идущего расчёта пакета (3.2): DELETE на сервере + локальный статус */
  cancelBatch: () => void
  /** Отмена идущего расчёта спектра (3.2) */
  cancelSpectrum: () => void
  /**
   * Точное уточнение эпохи (BEM fit_dipole): параметры нарезки берутся из
   * **результата** быстрого расчёта (`buildRefineForm`), а не из формы панели.
   */
  refineEpoch: (recordingId: string | null, epochIndex: number) => Promise<void>
  /**
   * eLORETA одной эпохи (остаток B9): форма нарезки — та же, что у refine
   * (`buildRefineForm`), окно — общий `refineHalfwinMs`.
   */
  runEloreta: (recordingId: string | null, epochIndex: number) => Promise<void>
  /**
   * Окно свободного фитинга уточнения, мс (0 — только пик GFP, шаг 1.5).
   * Предпочтение просмотра и персистится: «сколько ждать» пользователь выбирает
   * один раз, а не перед каждым уточнением. Значение — из списка вариантов.
   */
  refineHalfwinMs: number
  /** Окно уточнения из списка вариантов (`REFINE_HALFWIN_OPTIONS`) */
  setRefineHalfwinMs: (value: number) => void
  /** Сброс результатов (закрытие записи) — параметры остаются */
  reset: () => void
}

export const useDipoleCalc = create<DipoleCalcState>()(
  persist(
    (set, get) => ({
      view: 'none',
      gofThresholdPercent: 0,
      amplitudeThresholdNam: 0,
      fftRangeHz: null,
      selectedPointId: null,
      selectedEpochIndex: null,
      playback: { ...PLAYBACK_DEFAULTS },
      params: { ...CALC_PARAM_DEFAULTS },
      result: null,
      batch: null,
      batchJob: null,
      batchError: null,
      activeBandKey: null,
      playbackBandKeys: [],
      spectrumJob: null,
      spectrum: null,
      spectrumError: null,
      refineJob: null,
      refiningEpoch: null,
      refinedPoints: {},
      refineError: null,
      eloretaJob: null,
      eloretaEpochIndex: null,
      eloretaResults: {},
      eloretaError: null,
      // Окно уточнения — предпочтение просмотра (персистится): по умолчанию
      // только пик GFP, то есть ≈8 с вместо ≈80 с на окне ±10 мс (шаг 1.5)
      refineHalfwinMs: 0,

      setView: (view) => set({ view }),
      toggleView: (view) => set((state) => ({ view: state.view === view ? 'none' : view })),

      setGofThreshold: (value) =>
        set({ gofThresholdPercent: clamp(value, GOF_THRESHOLD_RANGE) }),
      setAmplitudeThreshold: (value) =>
        set({ amplitudeThresholdNam: clamp(value, THRESHOLD_NAM_RANGE) }),
      setFftRange: (range) => set({ fftRangeHz: normalizeFreqWindow(range) }),
      toggleSelectedPoint: (id) =>
        set((state) => ({ selectedPointId: state.selectedPointId === id ? null : id })),
      clearSelectedPoint: () => set({ selectedPointId: null }),
      // Клик по ячейке индикатора: выбор пакета диполей эпохи + перемотка кадра
      // (команда `seekSeq`, чтобы часы проиграли переход). Повторный клик — снять.
      toggleSelectedEpoch: (epochIndex) =>
        set((state) => {
          const next = state.selectedEpochIndex === epochIndex ? null : epochIndex
          if (next === null) return { selectedEpochIndex: null }
          const total = state.result?.n_epochs_total ?? 0
          return {
            selectedEpochIndex: next,
            ...(total > 0
              ? {
                  playback: {
                    ...state.playback,
                    playing: false,
                    active: true,
                    epochIndex: clampEpochIndex(next, total),
                    seekSeq: state.playback.seekSeq + 1,
                  },
                }
              : {}),
          }
        }),
      clearSelectedEpoch: () => set({ selectedEpochIndex: null }),

      togglePlayback: () => {
        const { result, playback } = get()
        // Без точек и сетки эпох кадры пусты: кнопка выключена в шапке, а действие
        // не «играет вхолостую»
        if (!canPlayback(result)) return
        if (playback.playing) {
          // Пауза: часы останавливаются, кадр остаётся на текущей эпохе и
          // показывается **измеренной** точкой (доля внутри эпохи — ноль)
          set({ playback: { ...playback, playing: false } })
          return
        }
        // Play с последнего кадра начинает запись сначала: иначе кнопка «играет»,
        // а картинка стоит на месте
        const atEnd = playback.epochIndex >= (result?.n_epochs_total ?? 1) - 1
        set({
          playback: {
            ...playback,
            playing: true,
            active: true,
            epochIndex: atEnd ? 0 : playback.epochIndex,
            seekSeq: playback.seekSeq + 1,
          },
        })
      },
      pausePlayback: () =>
        set((state) =>
          state.playback.playing ? { playback: { ...state.playback, playing: false } } : {},
        ),
      setPlaybackSpeed: (speed) =>
        set((state) => ({ playback: { ...state.playback, speed: normalizePlaybackSpeed(speed) } })),
      seekPlaybackEpoch: (epochIndex) =>
        set((state) => {
          const total = state.result?.n_epochs_total ?? 0
          if (total <= 0) return {}
          const next = clampEpochIndex(epochIndex, total)
          return {
            playback: {
              ...state.playback,
              playing: false,
              active: true,
              epochIndex: next,
              seekSeq: state.playback.seekSeq + 1,
            },
            // Перемотка = показать эту эпоху: белая рамка индикатора и пакет
            // диполей проекций переезжают вместе с кадром
            selectedEpochIndex: next,
          }
        }),
      clearPlaybackFrame: () =>
        set((state) => ({
          playback: { ...state.playback, playing: false, active: false },
          // «Снять кадр» убирает и выделение эпохи: облако диполей возвращается
          // в полный вид (как обещает подсказка кнопки)
          selectedEpochIndex: null,
        })),
      setPlaybackEpoch: (epochIndex) =>
        set((state) => {
          const next = clampEpochIndex(epochIndex, state.result?.n_epochs_total ?? 0)
          // Часы пишут кадр на каждом переходе эпохи: при том же номере стор не
          // трогаем, иначе кадры 60 раз в секунду давали бы лишние перерисовки
          if (next === state.playback.epochIndex) return {}
          return {
            playback: { ...state.playback, epochIndex: next },
            // Выделение следует за кадром (правка 19.10.2026): белая рамка
            // индикатора едет по эпохам в Плей, и проекции показывают пакет
            // диполей той эпохи, где стоит анимация
            selectedEpochIndex: next,
          }
        }),

      setEpochLengthMs: (value) =>
        set((state) => ({ params: { ...state.params, epochLengthMs: Math.round(value) } })),
      setGridMm: (value) =>
        set((state) => ({ params: { ...state.params, gridMm: clamp(value, GRID_MM_RANGE) } })),
      setPsdMethod: (value) =>
        set((state) => ({ params: { ...state.params, psdMethod: value } })),
      // Окно уточнения — только варианты списка: произвольное число здесь значило
      // бы «случайные 40 секунд счёта», а не выбор точности (шаг 1.5)
      setRefineHalfwinMs: (value) => set({ refineHalfwinMs: normalizeRefineHalfwin(value) }),
      setNotchHz: (value) =>
        set((state) => ({ params: { ...state.params, notchHz: normalizeNotchHz(value) } })),

      runBatch: async (recordingId, bandKeys) => {
        if (!recordingId) return
        // Пакет всегда считает весь каталог полос («Расчёт пакета» вместо
        // одиночного расчёта): дубли ключей снимаются, порядок — как в каталоге.
        const keys = [...new Set(bandKeys)]
        if (keys.length === 0) {
          set({ batchError: 'Каталог полос пуст: нет данных /meta для пакета' })
          return
        }
        const params = get().params
        const token = calcRunToken.next()
        const isCurrent = () => calcRunToken.isCurrent(token)
        set({ batchJob: runningJob(), batchError: null })
        try {
          const created = await api.dipoleBatch.start(
            recordingId,
            buildDipoleBatchForm({
              bandKeys: keys,
              epochLengthMs: params.epochLengthMs,
              gridMm: params.gridMm,
              notchHz: params.notchHz,
              reference: 'average',
              referenceChannels: null,
            }),
          )
          // id задачи — сразу после 202: отмена работает и до первого опроса (3.2)
          set({ batchJob: { ...(get().batchJob ?? runningJob()), jobId: created.job_id } })
          await waitForJob(created.job_id, isCurrent, (status) =>
            set({ batchJob: calcJobFromStatus(status) }),
          )
          if (!isCurrent()) return
          const batch = await api.dipoleBatch.result(recordingId, created.job_id)
          if (!isCurrent()) return
          const bands = batch.bands ?? []
          const first = bands.find((band) => band.state === 'ok') ?? bands[0]
          set({
            batch,
            batchJob: succeededJob(get().batchJob),
            activeBandKey: first?.band_key ?? null,
            // Чекбоксы анимации/облака (п.1.4): после прогона отмечены все полосы
            playbackBandKeys: bands.map((band) => band.band_key),
            // Проекции/таблица/подписи читают `result` — кладём в него скан
            // активной полосы набора (та же нарезка, свои точки)
            result: first ? scanResultOfBand(batch, first) : null,
            // Уточнения/eLORETA/кадр/выбор эпохи привязаны к прежней нарезке —
            // снимаются (новая нарезка делает их чужими)
            refinedPoints: {},
            refineJob: null,
            refiningEpoch: null,
            refineError: null,
            eloretaResults: {},
            eloretaJob: null,
            eloretaEpochIndex: null,
            eloretaError: null,
            selectedPointId: null,
            selectedEpochIndex: null,
            playback: {
              ...get().playback,
              playing: false,
              active: false,
              epochIndex: 0,
              seekSeq: 0,
            },
          })
        } catch (error) {
          if (isCancelled(error) || !isCurrent()) return
          set({
            batchJob: failedJob(get().batchJob, apiErrorText(error)),
            batchError: apiErrorText(error),
          })
        }
      },

      setActiveBand: (bandKey) =>
        set((state) => {
          const batch = state.batch
          const band = (batch?.bands ?? []).find((item) => item.band_key === bandKey) ?? null
          if (!batch || !band || bandKey === state.activeBandKey) return {}
          return {
            activeBandKey: bandKey,
            result: scanResultOfBand(batch, band),
            // Прежние выделение/уточнения/кадр относились к точкам другой полосы
            selectedPointId: null,
            selectedEpochIndex: null,
            refinedPoints: {},
            refiningEpoch: null,
            refineError: null,
            eloretaResults: {},
            eloretaEpochIndex: null,
            eloretaError: null,
            playback: {
              ...state.playback,
              playing: false,
              active: false,
              epochIndex: 0,
              seekSeq: 0,
            },
          }
        }),

      togglePlaybackBand: (bandKey) =>
        set((state) => ({
          playbackBandKeys: state.playbackBandKeys.includes(bandKey)
            ? state.playbackBandKeys.filter((key) => key !== bandKey)
            : [...state.playbackBandKeys, bandKey],
        })),

      setPlaybackBandKeys: (bandKeys) => set({ playbackBandKeys: [...new Set(bandKeys)] }),

      runSpectrum: async (recordingId) => {
        if (!recordingId) return
        const params = get().params
        const token = calcRunToken.next()
        const isCurrent = () => calcRunToken.isCurrent(token)
        set({ spectrumJob: runningJob(), spectrumError: null })
        try {
          const created = await api.spectrum.start(recordingId, buildSpectrumForm(params))
          // id задачи — сразу после 202: отмена работает и до первого опроса (3.2)
          set({ spectrumJob: { ...(get().spectrumJob ?? runningJob()), jobId: created.job_id } })
          await waitForJob(created.job_id, isCurrent, (status) =>
            set({ spectrumJob: calcJobFromStatus(status) }),
          )
          if (!isCurrent()) return
          const spectrum = await api.spectrum.result(recordingId, created.job_id)
          if (!isCurrent()) return
          set({ spectrum, spectrumJob: succeededJob(get().spectrumJob) })
        } catch (error) {
          if (isCancelled(error) || !isCurrent()) return
          set({
            spectrumJob: failedJob(get().spectrumJob, apiErrorText(error)),
            spectrumError: apiErrorText(error),
          })
        }
      },

      refineEpoch: async (recordingId, epochIndex) => {
        const result = get().result
        if (!recordingId || !result) return
        const token = calcRunToken.next()
        const isCurrent = () => calcRunToken.isCurrent(token)
        set({
          refineJob: runningJob(),
          refiningEpoch: epochIndex,
          refineError: null,
        })
        try {
          const created = await api.dipoleRefine.start(
            recordingId, buildRefineForm(result, epochIndex, get().refineHalfwinMs),
          )
          await waitForJob(created.job_id, isCurrent, (status) =>
            set({ refineJob: calcJobFromStatus(status) }),
          )
          if (!isCurrent()) return
          const refined = await api.dipoleRefine.result(recordingId, created.job_id)
          // Ключ — ЗАПРОШЕННАЯ эпоха (она привязана к выбранной точке); номер из
          // ответа — эхо сервера, и расхождение не должно прятать результат
          if (refined.epoch_index !== epochIndex) {
            console.warn('dipole_refine: эпоха ответа не совпала с запрошенной', refined.epoch_index, epochIndex)
          }
          if (!isCurrent()) return
          set({
            refinedPoints: { ...get().refinedPoints, [epochIndex]: refined },
            refineJob: succeededJob(get().refineJob),
            refiningEpoch: null,
          })
        } catch (error) {
          if (isCancelled(error) || !isCurrent()) return
          set({
            refineJob: failedJob(get().refineJob, apiErrorText(error)),
            refineError: apiErrorText(error),
            refiningEpoch: null,
          })
        }
      },

      runEloreta: async (recordingId, epochIndex) => {
        const result = get().result
        if (!recordingId || !result) return
        const token = calcRunToken.next()
        const isCurrent = () => calcRunToken.isCurrent(token)
        set({
          eloretaJob: runningJob(),
          eloretaEpochIndex: epochIndex,
          eloretaError: null,
        })
        try {
          const created = await api.eloreta.start(
            recordingId, buildRefineForm(result, epochIndex, get().refineHalfwinMs),
          )
          await waitForJob(created.job_id, isCurrent, (status) =>
            set({ eloretaJob: calcJobFromStatus(status) }),
          )
          if (!isCurrent()) return
          const eloreta = await api.eloreta.result(recordingId, created.job_id)
          if (!isCurrent()) return
          set({
            eloretaResults: { ...get().eloretaResults, [epochIndex]: eloreta },
            eloretaJob: succeededJob(get().eloretaJob),
            eloretaEpochIndex: null,
          })
        } catch (error) {
          if (isCancelled(error) || !isCurrent()) return
          set({
            eloretaJob: failedJob(get().eloretaJob, apiErrorText(error)),
            eloretaError: apiErrorText(error),
            eloretaEpochIndex: null,
          })
        }
      },

      cancelBatch: () => {
        const job = get().batchJob
        if (job === null || job.status !== 'running' || !job.jobId) return
        cancelRemoteJob(job.jobId, calcRunToken)
        set({ batchJob: { ...job, status: 'cancelled' } })
      },

      cancelSpectrum: () => {
        const job = get().spectrumJob
        if (job === null || job.status !== 'running' || !job.jobId) return
        cancelRemoteJob(job.jobId, calcRunToken)
        set({ spectrumJob: { ...job, status: 'cancelled' } })
      },

      reset: () => {
        // Отменяем поллинг: ответы прежних задач не должны трогать новое состояние
        calcRunToken.cancel()
        set({
          result: null,
          // Набор пакета (С1) живёт с результатом — сбрасывается вместе с ним
          batch: null,
          batchJob: null,
          batchError: null,
          activeBandKey: null,
          playbackBandKeys: [],
          spectrumJob: null,
          spectrum: null,
          spectrumError: null,
          refineJob: null,
          refiningEpoch: null,
          refinedPoints: {},
          refineError: null,
          eloretaJob: null,
          eloretaEpochIndex: null,
          eloretaResults: {},
          eloretaError: null,
          // Выделенный диполь и выбранная эпоха жили в результате задачи — вместе
          // с ним они исчезают
          selectedPointId: null,
          selectedEpochIndex: null,
          // Кадр воспроизведения привязан к нарезке эпох результата: вместе с ним
          // он снимается, а скорость остаётся (предпочтение просмотра)
          playback: { ...get().playback, playing: false, active: false, epochIndex: 0, seekSeq: 0 },
        })
      },
    }),
    {
      name: 'diplock.dipoleCalc',
      // Результаты задач и выделение привязаны к записи: после перезагрузки
      // страницы они бессмысленны (файл живёт по TTL). Окно частот — наоборот,
      // предпочтение просмотра, оно переживает перезагрузку.
      partialize: (state) => ({
        view: state.view,
        gofThresholdPercent: state.gofThresholdPercent,
        amplitudeThresholdNam: state.amplitudeThresholdNam,
        fftRangeHz: state.fftRangeHz,
        params: state.params,
        // Окно уточнения — предпочтение просмотра: оно переживает перезагрузку
        // (результаты задач — нет, они привязаны к записи)
        refineHalfwinMs: state.refineHalfwinMs,
      }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<DipoleCalcState>
        const storedParams = (stored.params ?? {}) as Partial<CalcParams>
        const merged = { ...current.params, ...storedParams }
        return {
          ...current,
          view: stored.view ?? current.view,
          // Старое хранилище не знало GOF-порога: берём дефолт «выключен»
          gofThresholdPercent: stored.gofThresholdPercent ?? current.gofThresholdPercent,
          amplitudeThresholdNam: stored.amplitudeThresholdNam ?? current.amplitudeThresholdNam,
          fftRangeHz: normalizeFreqWindow(stored.fftRangeHz ?? current.fftRangeHz),
          // Окно уточнения из старого хранилища может быть любым числом (или его
          // не было): приводим к списку вариантов, а не отправляем в форму как есть
          refineHalfwinMs: normalizeRefineHalfwin(stored.refineHalfwinMs),
          selectedPointId: null,
          selectedEpochIndex: null,
          // Кадр воспроизведения — сессионное состояние: он не персистится, и после
          // перезагрузки страницы его нет (как и результата задачи) — берём дефолт
          playback: { ...PLAYBACK_DEFAULTS },
          // В числах старых сохранённых параметров мог оказаться мусор, а поля
          // формы фильтра одиночного расчёта удалены: `normalizeCalcParams`
          // приводит всё к правилам контролов, устаревшее просто отбрасывается
          params: normalizeCalcParams(merged),
        }
      },
    },
  ),
)

function runningJob(): CalcJob {
  return {
    status: 'running',
    progress: 0,
    message: '',
    stage: 'queued',
    epochsDone: 0,
    epochsTotal: 0,
    error: null,
  }
}

function succeededJob(previous: CalcJob | null): CalcJob {
  return {
    ...(previous ?? runningJob()),
    status: 'succeeded',
    progress: 1,
    epochsDone: previous?.epochsTotal ?? 0,
  }
}

function failedJob(previous: CalcJob | null, message: string): CalcJob {
  return { ...(previous ?? runningJob()), status: 'failed', progress: 0, error: message }
}
