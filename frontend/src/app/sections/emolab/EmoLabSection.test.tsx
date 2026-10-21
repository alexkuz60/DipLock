/**
 * Тесты раздела «ЕмоЛаб» (шаг 1): пустое состояние, открытие внешнего
 * аудиотрека → анализ (поллинг) → трекер-плеер (волна-бабочка, пирамида
 * превью, оверлеи темпа/аккордов), звезда-полигон «Эмо» и пиули
 * «Аккорд»/«Темп», паспорт трека в панели, cached/ошибка/транспорт.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from '@/test/renderWithProviders'
import * as neuromusicPlayerLib from '@/shared/lib/neuromusicPlayer'
import { api } from '@/shared/api/client'
import type { AudioEmo, EmoTrackStatus } from '@/shared/api/types'
import { useEmoLab } from '@/shared/state/emolab'
import { useNeuromusicPlayer } from '@/shared/state/neuromusicPlayer'
import { EMO_LABEL_W, EMO_PAD_LEFT, EMO_VIEW_W, emoTimeX } from './emogram'
import { EmoLabPanel } from './EmoLabPanel'
import { EmoLabSection } from './EmoLabSection'
import { EmoLabTitleFile, EmoLabToolActions } from './EmoLabToolActions'

/**
 * Мок HTTP-клиента: раздел зовёт три метода «ЕмоЛаб» — они подменяются
 * `vi.fn` (фабрика мока модуля надёжнее spyOn на объекте api).
 */
vi.mock('@/shared/api/client', () => {
  class ApiError extends Error {
    readonly status: number
    constructor(message: string, status: number) {
      super(message)
      this.status = status
    }
  }
  return {
    API_PREFIX: '/api/v1',
    ApiError,
    apiErrorText: (error: unknown) => String(error),
    request: vi.fn(),
    api: {
      emolabAnalyze: vi.fn(),
      emolabTrackStatus: vi.fn(),
      emolabTrackEmo: vi.fn(),
    },
  }
})

/**
 * Мок Tone-движка: jsdom без Web Audio — проверяем интеграцию (кто вызван,
 * какие URL), а не звук (приём `NeuromusicSection.test.tsx`).
 */
vi.mock('@/shared/lib/neuromusicPlayer', () => {
  const player = {
    duration: 4,
    position: 0,
    playing: false,
    currentSource: 'master',
    bufferFor: vi.fn(() => null),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    stop: vi.fn(),
    seek: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn(),
    setRate: vi.fn().mockResolvedValue(undefined),
    setSource: vi.fn().mockResolvedValue(undefined),
    setSpatial: vi.fn().mockResolvedValue(undefined),
    setWidth: vi.fn(),
    setSpread: vi.fn(),
    setWet: vi.fn(),
    setIrUrl: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  }
  return {
    NeuromusicPlayer: Object.assign(vi.fn().mockResolvedValue(player), {
      load: vi.fn().mockResolvedValue(player),
      __player: player,
    }),
  }
})

const playerMock = (
  neuromusicPlayerLib.NeuromusicPlayer as unknown as {
    load: ReturnType<typeof vi.fn>
    __player: {
      play: ReturnType<typeof vi.fn>
      stop: ReturnType<typeof vi.fn>
      seek: ReturnType<typeof vi.fn>
      position: number
    }
  }
).__player

/** Кадры «Эмо» с картами Соник Аннотатора (контракт GET …/emo, v4). */
const EMO_PAYLOAD: AudioEmo = {
  schema_version: 4,
  fs_audio: 32000,
  fft_size: 32768,
  hop_samples: 32000,
  overlap_samples: 768,
  normalization: 'db_relative',
  db_floor: -60,
  global_max: 4812.5,
  duration_s: 6,
  frame_count: 6,
  frames: Array.from({ length: 6 }, (_, index) => ({
    t_sec: index, // сетка шага 2: кадр = 32000 сэмплов при 32000 Гц = 1 с
    rays: Array.from({ length: 7 }, (_, ray) => Math.min(100, (ray + 1) * 10 + index * 10)),
  })),
  key_track: [
    { t_sec: 0, key_code: 1, label: 'C major' },
    { t_sec: 3.5, key_code: 13, label: 'C minor' },
  ],
  key_source: 'vamp:qm-vamp-plugins:qm-keydetector:key',
  tempo_track: [{ t_sec: 0, bpm: 120 }],
  tempo_source: 'vamp:qm-vamp-plugins:qm-tempotracker:tempo',
}

const STATUS_DONE: EmoTrackStatus = {
  track_id: 't1',
  status: 'succeeded' as const,
  stage: 'Готово',
  pct: 1,
  message: 'Кадров: 6',
  error: null,
  filename: 'song.wav',
  duration_s: 2,
}

/** Параметры мока API: cached ответа POST, статус анализа и кадры «Эмо». */
type MockOptions = {
  cached?: boolean
  status?: EmoTrackStatus
  emo?: AudioEmo
}

function mockApi(opts: MockOptions = {}) {
  vi.mocked(api.emolabAnalyze).mockResolvedValue({
    track_id: 't1',
    status: opts.cached ? 'succeeded' : 'running',
    cached: opts.cached ?? false,
    filename: 'song.wav',
    duration_s: 2,
  })
  vi.mocked(api.emolabTrackStatus).mockResolvedValue(opts.status ?? STATUS_DONE)
  vi.mocked(api.emolabTrackEmo).mockResolvedValue(opts.emo ?? EMO_PAYLOAD)
}

function renderEmoLab() {
  return renderWithProviders(
    <>
      <EmoLabTitleFile />
      <EmoLabToolActions />
      <EmoLabSection />
      <EmoLabPanel />
    </>,
  )
}

/** Выбор файла в скрытом инпуте (jsdom не умеет `user.upload` для accept). */
function pickFile() {
  const input = screen.getByTestId('emolab-file-input')
  fireEvent.change(input, {
    target: { files: [new File([new Uint8Array([1, 2, 3])], 'song.wav', { type: 'audio/wav' })] },
  })
}

/**
 * Радиусы вершин полигона-звезды в % радиуса графика: длины вершин от центра
 * (круг `data-part="frame"` несёт центр и радиус). Код тональности 1 (C major)
 * даёт нулевое вращение, темп 120 bpm — нулевую коррекцию (Kr = 0), поэтому
 * вершина i лежит строго на луче i и её радиус пропорционален лучу кадра.
 */
function starRadiiPct(): number[] {
  const frame = document.querySelector('[data-part="frame"]') as SVGCircleElement
  const cx = Number(frame.getAttribute('cx'))
  const cy = Number(frame.getAttribute('cy'))
  const radius = Number(frame.getAttribute('r'))
  const polygon = document.querySelector('[data-part="polygon"]') as SVGPolygonElement
  return (polygon.getAttribute('points') ?? '')
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number)
      return (Math.hypot(x - cx, y - cy) / radius) * 100
    })
}

/** Асимметричный матчер радиусов: % с допуском 0.05 (points — полный float). */
function raysCloseTo(pct: readonly number[]) {
  return pct.map((value) => expect.closeTo(value, 1))
}

beforeEach(() => {
  // jsdom без URL-бондов blob: плеер получает строку-заглушку.
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:mock'),
    configurable: true,
    writable: true,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  })
  // restoreAllMocks в vitest.setup.ts сбрасывает implementation всех vi.fn()
  // после каждого теста — перепривязываем resolved-значения движка (приём
  // `NeuromusicSection.test.tsx`).
  const engine = neuromusicPlayerLib.NeuromusicPlayer as unknown as {
    load: ReturnType<typeof vi.fn>
  }
  engine.load.mockResolvedValue(playerMock)
  playerMock.play.mockResolvedValue(undefined)
  playerMock.stop.mockResolvedValue(undefined)
  playerMock.seek.mockResolvedValue(undefined)
})

afterEach(() => {
  useEmoLab.getState().reset()
  useNeuromusicPlayer.getState().reset()
  vi.clearAllMocks()
})

afterAll(() => {
  vi.restoreAllMocks()
})

describe('ЕмоЛаб, шаг 1: анализ внешнего аудиотрека', () => {
  it('без файла — подсказка и кнопка «Открыть аудио»', () => {
    renderEmoLab()
    expect(screen.getByText(/Откройте аудиотрек \(wav\/mp3\)/)).toBeInTheDocument()
    expect(screen.getByTestId('emolab-open')).toBeInTheDocument()
    expect(screen.queryByTestId('emolab-tracker')).not.toBeInTheDocument()
  })

  it('открытие файла: анализ → трекер, звезда-полигон, пиули и паспорт', async () => {
    mockApi()
    renderEmoLab()
    pickFile()

    await waitFor(() => expect(screen.getByTestId('emolab-tracker')).toBeInTheDocument())
    expect(screen.getByTestId('emolab-visualization')).toBeInTheDocument()
    expect(screen.getByTestId('emolab-title-file')).toHaveTextContent('song.wav')
    // Пиули «Аккорд»/«Темп» из кадров «Эмо» (компоненты «Нейромузыки», пишутся rAF).
    await waitFor(() =>
      expect(screen.getByTestId('emo-counter-key')).toHaveTextContent('C major'),
    )
    expect(screen.getByTestId('emo-counter-tempo')).toHaveTextContent('120')
    // Паспорт в панели: файл и «Анализ: Готово» (текст дублирует пилюлю).
    expect(screen.getAllByText('song.wav').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('Готово').length).toBeGreaterThanOrEqual(2)
    // Движок построен из blob URL локального файла (плеер без сервера).
    const loadMock = (
      neuromusicPlayerLib.NeuromusicPlayer as unknown as { load: ReturnType<typeof vi.fn> }
    ).load
    expect(loadMock).toHaveBeenCalledWith(
      expect.objectContaining({ masterUrl: 'blob:mock', spatial: false, rate: 1 }),
    )
  })

  it('повторное открытие: результат из кэша сервера', async () => {
    mockApi({ cached: true })
    renderEmoLab()
    pickFile()

    await waitFor(() =>
      expect(screen.getAllByText('Готово (из кэша)').length).toBeGreaterThanOrEqual(2),
    )
    expect(screen.getByTestId('emolab-tracker')).toBeInTheDocument()
  })

  it('ошибка анализа показывается текстом из статуса', async () => {
    mockApi({
      status: {
        ...STATUS_DONE,
        status: 'failed',
        stage: 'Готово',
        pct: 1,
        error: 'файл повреждён',
      },
    })
    renderEmoLab()
    pickFile()

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('файл повреждён'))
    expect(screen.getByText('Ошибка')).toBeInTheDocument()
    // Трекер остаётся: локальный файл играет и без серверного анализа
    // (звезда-полигон — на фоллбэк-лучах до успешных кадров).
    expect(screen.getByTestId('emolab-tracker')).toBeInTheDocument()
  })

  it('транспорт: Play зовёт движок, зум переключает окно', async () => {
    mockApi()
    renderEmoLab()
    pickFile()
    await waitFor(() => expect(screen.getByTestId('transport-play')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('transport-play'))
    await waitFor(() => expect(playerMock.play).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: '×10' }))
    expect(useNeuromusicPlayer.getState().zoom).toBe(10)
    // Скорость в «ЕмоЛаб» только ×1 — контрола «Скорость» нет.
    expect(screen.queryByText('Скорость')).not.toBeInTheDocument()
  })

  it('анимация звезды синхронизирована с плей: кадр = 1 с сетки 32 кГц', async () => {
    mockApi()
    renderEmoLab()
    pickFile()
    await waitFor(() => expect(screen.getByTestId('radial-chart')).toBeInTheDocument())

    // Позиция плеера 0 — кадр 0 сетки (t_sec = 0): лучи 10…70 % радиуса.
    playerMock.position = 0
    await waitFor(() =>
      expect(starRadiiPct()).toEqual(raysCloseTo([10, 20, 30, 40, 50, 60, 70])),
    )

    // Позиция 3.0 — кадр 3 (t_sec = 3 с): лучи 40…100 % (рост по кадрам).
    playerMock.position = 3
    await waitFor(() =>
      expect(starRadiiPct()).toEqual(raysCloseTo([40, 50, 60, 70, 80, 90, 100])),
    )

    // Середина кадров 2 и 3 (t = 2.5) — линейная интерполяция слайдов.
    playerMock.position = 2.5
    await waitFor(() =>
      expect(starRadiiPct()).toEqual(raysCloseTo([35, 45, 55, 65, 75, 85, 95])),
    )
  })

  it('панель: таблица аккордов, динамический диапазон и чекбокс темпа; инфо-строки убраны', async () => {
    mockApi()
    renderEmoLab()
    pickFile()
    await waitFor(() => expect(screen.getAllByText('Готово').length).toBeGreaterThanOrEqual(2))

    // Строки карт VAMP остаются; под картой аккордов — таблица сегментов.
    expect(screen.getByText('Карта аккордов')).toBeInTheDocument()
    expect(screen.getAllByText('VAMP Key Detector').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Карта темпа')).toBeInTheDocument()
    expect(screen.getByText('Время')).toBeInTheDocument()
    expect(screen.getByText('Тип (минор/мажор)')).toBeInTheDocument()
    // Аккорд — метка QM без слова лада («C major» → «C»), тип — по коду.
    expect(screen.getAllByText('C')).toHaveLength(2)
    expect(screen.getByText('мажор')).toBeInTheDocument()
    expect(screen.getByText('минор')).toBeInTheDocument()

    // Динамический диапазон — −60…0 по умолчанию (шкала контракта).
    expect(screen.getByLabelText('Динамический диапазон')).toHaveValue('60')
    // Чекбокс значений темпа включён (поведение «Нейромузыки»).
    expect(screen.getByLabelText('Учитывать темп при расчёте лучей звезды')).toBeChecked()

    // Прочие инфо-строки параметров анализа убраны (правка 21.10.2026).
    for (const label of [
      'Частота моно-файла',
      'Окно FFT',
      'Сдвиг окна',
      'Лучей полигона',
      'Скорость плеера',
    ]) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
  })

  it('динамический диапазон: −40…0 растягивает лучи, −96…0 сжимает шкалу', async () => {
    mockApi()
    renderEmoLab()
    pickFile()
    await waitFor(() => expect(screen.getByTestId('radial-chart')).toBeInTheDocument())
    playerMock.position = 0
    await waitFor(() =>
      expect(starRadiiPct()).toEqual(raysCloseTo([10, 20, 30, 40, 50, 60, 70])),
    )

    // −60…0 → −40…0: ×60/40 с зажимом 100 % (луч 70 → 105 → 100).
    fireEvent.change(screen.getByLabelText('Динамический диапазон'), {
      target: { value: '40' },
    })
    await waitFor(() =>
      expect(starRadiiPct()).toEqual(raysCloseTo([15, 30, 45, 60, 75, 90, 100])),
    )

    // −60…0 → −96…0: ×60/96 — вся звезда ужимается к центру.
    fireEvent.change(screen.getByLabelText('Динамический диапазон'), {
      target: { value: '96' },
    })
    await waitFor(() =>
      expect(starRadiiPct()).toEqual(
        [6.25, 12.5, 18.75, 25, 31.25, 37.5, 43.75].map((value) => expect.closeTo(value, 2)),
      ),
    )
  })

  it('чекбокс темпа: выкл — лучи звезды без темп-коррекции значений VAMP', async () => {
    // 240 bpm: Kr = 1 — вершины верхней половины (лучи 0, 1, 5, 6) удвоены,
    // условная нормализация делит все на max (140 → 100 %).
    mockApi({ emo: { ...EMO_PAYLOAD, tempo_track: [{ t_sec: 0, bpm: 240 }] } })
    renderEmoLab()
    pickFile()
    await waitFor(() => expect(screen.getByTestId('radial-chart')).toBeInTheDocument())
    playerMock.position = 0
    await waitFor(() =>
      expect(starRadiiPct()).toEqual(raysCloseTo([14.3, 28.6, 21.4, 28.6, 35.7, 85.7, 100])),
    )

    fireEvent.click(screen.getByLabelText('Учитывать темп при расчёте лучей звезды'))
    await waitFor(() =>
      expect(starRadiiPct()).toEqual(raysCloseTo([10, 20, 30, 40, 50, 60, 70])),
    )
  })

  it('гамма полос «Диполей»: дуги секторов 1…7 и залитые круги вершин ⌀10 px', async () => {
    mockApi()
    renderEmoLab()
    pickFile()
    await waitFor(() => expect(screen.getByTestId('radial-chart')).toBeInTheDocument())

    const chart = screen.getByTestId('radial-chart')
    const arcs = chart.querySelectorAll('[data-part="sector-arc"]')
    expect(arcs).toHaveLength(7)
    // δ — красный (hsl 0°), γ-high — розово-фиолетовый (hsl 275°): якоря
    // гаммы `bandColors.ts` (та же, что у базовых полос «Диполей»).
    expect(arcs[0]?.getAttribute('stroke')).toBe('hsl(0.0, 85%, 55.0%)')
    expect(arcs[6]?.getAttribute('stroke')).toBe('hsl(275.0, 85%, 70.0%)')

    // Круги вершин — цветом своего сектора, ⌀10 px (strokeWidth 10, round-cap).
    const dots = chart.querySelectorAll('[data-part="vertex-dot"]')
    expect(dots).toHaveLength(7)
    expect(dots[0]?.getAttribute('stroke')).toBe('hsl(0.0, 85%, 55.0%)')
    expect(dots[0]?.getAttribute('stroke-width')).toBe('10')
    expect(dots[6]?.getAttribute('stroke')).toBe('hsl(275.0, 85%, 70.0%)')
  })

  it('табы визуализации: «Звезда» по умолчанию, переключение на «Эмограмму» и обратно', async () => {
    mockApi()
    renderEmoLab()
    pickFile()
    await waitFor(() => expect(screen.getByTestId('radial-chart')).toBeInTheDocument())
    // Таб «Звезда» — дефолт: звезда занимает всю секцию, эмограммы нет.
    expect(screen.queryByTestId('emogram')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Эмограмма' }))
    expect(screen.getByTestId('emogram')).toBeInTheDocument()
    expect(screen.queryByTestId('radial-chart')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Звезда' }))
    expect(screen.getByTestId('radial-chart')).toBeInTheDocument()
    expect(screen.queryByTestId('emogram')).not.toBeInTheDocument()
  })

  it('таб «Эмограмма»: сетка 14 эмо, ряды кадров и курсор плеера', async () => {
    mockApi()
    renderEmoLab()
    pickFile()
    await waitFor(() => expect(screen.getByTestId('radial-chart')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Эмограмма' }))
    const emogram = screen.getByTestId('emogram')
    expect(emogram.querySelectorAll('[data-part="emo-grid"]')).toHaveLength(14)
    expect(emogram.querySelectorAll('[data-part="emo-label"]')).toHaveLength(14)
    // 6 кадров мока (лучи все > 0) — по столбику «Экспрессии» и ступени
    // «Динамики» на каждый.
    expect(emogram.querySelectorAll('[data-part="express-bar"]')).toHaveLength(6)
    expect(emogram.querySelectorAll('[data-part="emo-step"]')).toHaveLength(6)

    // Курсор позиции плеера: 3 с из 6 — середина шкалы времени (jsdom: ширина
    // полотна дефолтная, rAF пишет x1/x2 вертикали императивно).
    const playhead = emogram.querySelector('[data-part="playhead"]') as SVGLineElement
    const expectedX =
      EMO_PAD_LEFT + emoTimeX(3, 6, EMO_VIEW_W - EMO_LABEL_W - EMO_PAD_LEFT)
    playerMock.position = 3
    await waitFor(() => expect(Number(playhead.getAttribute('x1'))).toBeCloseTo(expectedX, 3))
  })
})