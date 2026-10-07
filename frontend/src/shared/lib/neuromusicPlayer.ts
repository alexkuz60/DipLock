/**
 * Единый Tone.js-плеер «Нейромузыки» (docs/rules/neuromusic.md, §«Плеер-трекер»;
 * spatial-audio.md, п.1): транспорт, выбор источника, скорость и 3D-цепочка.
 *
 * Граф:
 *  - обычный режим: `Player(выбранный сигнал) → master → destination`;
 *  - 3D «Экспресс»: 7 × `Player → StereoWidener → Panner3D → dry/wet
 *    Convolver → master`;
 *  - 3D «Монтаж»: 28 стемов (4 ряда × 7 полос) теми же узлами, но выходы
 *    panner'ов сходятся в **4 модуля-ряда** (`Tone.Gain` на ряд), общая
 *    Convolver висит на сумме модулей (спецификация 07.10.2026);
 *  - источник «Микс» — вся сцена, полоса — соло (в «Монтаже» — 4 рядовых
 *    стема полосы), остальные стемы в `mute` и остаются синхронными.
 *
 * Буферы грузятся ДО построения графа (`load`/`setSource`/`setSpatial`) —
 * reject без осиротевших AudioNode; закэшированные `ToneAudioBuffer`
 * переиспользуются и отдаются трекеру для волны (`bufferFor`; для полосы
 * «Монтажа» — сумма её рядовых стемов).
 *
 * Скорость — только `player.playbackRate` (×0.5 для слухового контроля быстрых
 * перемещений; в результат не попадает, питч при замедлении падает — допустимо,
 * уточнение владельца 06.10.2026). Смена скорости — перестарт с той же позиции.
 */
import * as Tone from 'tone'
import {
  SOURCE_DISTANCE_M,
  moduleSourcePosition,
  sourcePositions,
  spreadParam,
  widthParam,
  wetParam,
} from './spatialLayout'

/** Скорость воспроизведения: только замедление (×0.5 / ×1.0). */
export type NeuromusicRate = 0.5 | 1

/**
 * Строка трека: ключ полосы (из `freq_bands`), URL WAV и — для «Монтажа» —
 * ряд модуля (`row`): без ряда это «Экспресс»-трек на общей дуге.
 */
export type NeuromusicTrack = { key: string; url: string; row?: string }

export type NeuromusicPlayerOptions = {
  /** URL WAV-мастера — «микс до пост-обработки» */
  masterUrl: string
  /** Семь полосовых стемов в порядке партитуры */
  tracks: NeuromusicTrack[]
  /** URL WAV импульсной характеристики (нужен только 3D-режиму) */
  irUrl: string
  /** Источник: 'master' либо ключ полосы */
  source: string
  /** Стартовая скорость */
  rate: NeuromusicRate
  /** 3D-режим (пространственная пост-обработка) */
  spatial: boolean
  /** Ширина стереобазы, % (100 — без изменения) */
  widthPct: number
  /** Разброс по дуге, % (100 — ±60°) */
  spreadPct: number
  /** Влажность реверберации, % (0 — сухой сигнал) */
  wetPct: number
}

export class NeuromusicPlayer {
  /** Кэш декодированных WAV: URL → буфер (в т.ч. для волны трекера) */
  private readonly buffers = new Map<string, Tone.ToneAudioBuffer>()
  private readonly masterUrl: string
  private readonly tracks: NeuromusicTrack[]
  private irUrl: string
  private source: string
  private rate: NeuromusicRate
  private spatial: boolean
  private widthPct: number
  private spreadPct: number
  private wetPct: number

  /** Общий выход графа: создаётся один раз, переживает перестройки режима. */
  private readonly out: Tone.Gain
  /**
   * Обычный режим: единственный играющий сигнал. Для полосы «Монтажа» это
   * **сумма** её рядовых стемов (`bufferFor` → `sumOf`), поэтому плеер один.
   */
  private single: Tone.Player | null = null
  /** 3D-режим */
  private readonly players: Tone.Player[] = []
  private readonly wideners: Tone.StereoWidener[] = []
  private readonly panners: Tone.Panner3D[] = []
  /** «Монтаж»: модуль-ряд — сумма panner'ов ряда → общий dry/wet. */
  private readonly moduleGains = new Map<string, Tone.Gain>()
  /** Слот трека в своём ряде (индекс внутри ряда, размер ряда) — для позиций. */
  private rowSlots: { index: number; count: number }[] = []
  private convolver: Tone.Convolver | null = null
  private dry: Tone.Gain | null = null
  private wet: Tone.Gain | null = null
  /** Кэш суммы рядовых стемов полосы (волна/длительность «Монтажа»). */
  private readonly summed = new Map<string, Tone.ToneAudioBuffer>()

  /** Момент старта текущего проигрывания (аудио-контекст, сек) */
  private startClock: number | null = null
  /** Запомненная позиция между play/pause, сек (в времени источника) */
  private offset = 0
  private _playing = false

  private constructor(options: NeuromusicPlayerOptions) {
    this.masterUrl = options.masterUrl
    this.tracks = options.tracks
    this.irUrl = options.irUrl
    this.source = options.source
    this.rate = options.rate
    this.spatial = options.spatial
    this.widthPct = options.widthPct
    this.spreadPct = options.spreadPct
    this.wetPct = options.wetPct
    this.out = new Tone.Gain(1).toDestination()
  }

  /**
   * Грузит буферы выбранного источника (плюс стемы и IR в 3D-режиме) и
   * строит граф; начальные параметры применяются сеттерами — один путь с
   * real-time обновлениями из UI.
   */
  static async load(options: NeuromusicPlayerOptions): Promise<NeuromusicPlayer> {
    const player = new NeuromusicPlayer(options)
    const urls = new Set<string>()
    const sourceUrls = player.urlsOf(options.source)
    if (sourceUrls) {
      for (const url of sourceUrls) urls.add(url)
    }
    if (options.spatial) {
      for (const track of options.tracks) urls.add(track.url)
      urls.add(options.irUrl)
    }
    await Promise.all([...urls].map((url) => player.loadBuffer(url)))
    player.buildGraph()
    player.applySpatialParams()
    return player
  }

  /**
   * URL сигнала: 'master' → мастер, иначе полоса. «Монтаж» отдаёт массив
   * рядовых стемов полосы (4 файла), «Экспресс» — один; `null` — неизвестный.
   */
  private urlsOf(source: string): string[] | null {
    if (source === 'master') return [this.masterUrl]
    const urls = this.tracks.filter((track) => track.key === source).map((track) => track.url)
    return urls.length > 0 ? urls : null
  }

  /** Загрузка одного WAV через Tone (fetch + decode) с кэшем; reject — HTTP/декод. */
  private loadBuffer(url: string): Promise<Tone.ToneAudioBuffer> {
    const cached = this.buffers.get(url)
    if (cached) return Promise.resolve(cached)
    return new Promise((resolve, reject) => {
      const buffer = new Tone.ToneAudioBuffer(
        url,
        () => {
          this.buffers.set(url, buffer)
          resolve(buffer)
        },
        (error) => reject(new Error(`Не удалось загрузить аудио «${url}»: ${error.message}`)),
      )
    })
  }

  /**
   * Буфер сигнала для отрисовки волны (сухой сигнал до любых эффектов):
   * `null` — буфер ещё не загружен (загрузка идёт, трекер показывает пустоту).
   * У полосы «Монтажа» — сумма её рядовых стемов (кэшируется).
   */
  bufferFor(source: string): Tone.ToneAudioBuffer | null {
    const urls = this.urlsOf(source)
    if (!urls) return null
    if (urls.length === 1) return this.buffers.get(urls[0]) ?? null
    return this.sumOf(urls)
  }

  /**
   * Сумма уже загруженных буферов → один (волна полосы «Монтажа» рисует
   * фактический микс её рядов). В `jsdom` нет конструктора `AudioBuffer` —
   * возвращается первый стем (плеер в тестах замокан, путь недостижим).
   */
  private sumOf(urls: string[]): Tone.ToneAudioBuffer | null {
    const key = urls.join('|')
    const cached = this.summed.get(key)
    if (cached) return cached
    const buffers = urls
      .map((url) => this.buffers.get(url))
      .filter((buffer): buffer is Tone.ToneAudioBuffer => buffer !== undefined)
    if (buffers.length === 0) return null
    if (buffers.length === 1) return buffers[0]
    if (buffers.length !== urls.length) return null // часть стемов ещё грузится
    const length = Math.max(...buffers.map((buffer) => buffer.length))
    const channels = Math.max(...buffers.map((buffer) => buffer.numberOfChannels))
    const sampleRate = buffers[0].sampleRate
    if (typeof AudioBuffer === 'undefined') return buffers[0]
    const mixed = Array.from({ length: channels }, () => new Float32Array(length))
    for (const buffer of buffers) {
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel)
        const target = mixed[Math.min(channel, channels - 1)]
        for (let i = 0; i < data.length; i++) target[i] += data[i]
      }
    }
    const audioBuffer = new AudioBuffer({ length, numberOfChannels: channels, sampleRate })
    mixed.forEach((data, channel) => audioBuffer.copyToChannel(data, channel))
    const toneBuffer = new Tone.ToneAudioBuffer(audioBuffer)
    this.summed.set(key, toneBuffer)
    return toneBuffer
  }

  /** Постройка графа по текущему режиму (буферы уже должны быть в кэше). */
  private buildGraph(): void {
    if (this.spatial) this.buildSpatial()
    else this.buildSingle()
  }

  /** Обычный режим: выбранный сигнал → master. */
  private buildSingle(): void {
    const buffer = this.bufferFor(this.source)
    if (!buffer) throw new Error(`Сигнал «${this.source}» не загружен`)
    const player = new Tone.Player(buffer)
    player.playbackRate = this.rate
    player.connect(this.out)
    this.single = player
  }

  /** 3D-режим: стемы на дуге («Экспресс») или в 4 модулях рядов («Монтаж»). */
  private buildSpatial(): void {
    const irBuffer = this.buffers.get(this.irUrl)
    if (!irBuffer) throw new Error(`IR «${this.irUrl}» не загружен`)
    this.convolver = new Tone.Convolver({ url: irBuffer, normalize: true })
    const dry = new Tone.Gain(1)
    const wet = new Tone.Gain(0)
    this.dry = dry
    this.wet = wet
    dry.connect(this.out)
    this.convolver.connect(wet)
    wet.connect(this.out)
    const convolver = this.convolver

    const spread = spreadParam(this.spreadPct)
    const arc = sourcePositions(this.tracks.length, spread)
    this.rowSlots = this.computeRowSlots()
    this.tracks.forEach((track, index) => {
      const buffer = this.buffers.get(track.url)
      if (!buffer) throw new Error(`Трек «${track.key}» не загружен`)
      const player = new Tone.Player(buffer)
      player.playbackRate = this.rate
      const widener = new Tone.StereoWidener(widthParam(this.widthPct))
      const slot = this.rowSlots[index]
      const position =
        track.row && slot
          ? moduleSourcePosition(track.row, slot.index, slot.count, spread)
          : arc[index]
      const panner = new Tone.Panner3D({
        panningModel: 'HRTF',
        distanceModel: 'inverse',
        refDistance: SOURCE_DISTANCE_M,
        rolloffFactor: 1,
        positionX: position.x,
        positionY: position.y,
        positionZ: position.z,
      })
      player.connect(widener)
      widener.connect(panner)
      if (track.row) {
        // Модуль ряда: сумма его panner'ов → общий dry/wet (цепочка из
        // 4 модулей с одной Convolver, спецификация 07.10.2026).
        let moduleGain = this.moduleGains.get(track.row)
        if (!moduleGain) {
          moduleGain = new Tone.Gain(1)
          moduleGain.connect(dry)
          moduleGain.connect(convolver)
          this.moduleGains.set(track.row, moduleGain)
        }
        panner.connect(moduleGain)
      } else {
        panner.connect(dry)
        panner.connect(convolver)
      }
      this.players.push(player)
      this.wideners.push(widener)
      this.panners.push(panner)
    })
    this.applyMute()
  }

  /** Слот каждого трека внутри своего ряда: (индекс в ряду, размер ряда). */
  private computeRowSlots(): { index: number; count: number }[] {
    const counts = new Map<string, number>()
    for (const track of this.tracks) {
      if (!track.row) continue
      counts.set(track.row, (counts.get(track.row) ?? 0) + 1)
    }
    const seen = new Map<string, number>()
    return this.tracks.map((track) => {
      if (!track.row) return { index: 0, count: this.tracks.length }
      const index = seen.get(track.row) ?? 0
      seen.set(track.row, index + 1)
      return { index, count: counts.get(track.row) ?? 1 }
    })
  }

  /** Полная разборка активного режима (смена режима/размонтирование). */
  private teardownGraph(): void {
    if (this.single) {
      this.single.dispose()
      this.single = null
    }
    for (const player of this.players) player.dispose()
    for (const widener of this.wideners) widener.dispose()
    for (const panner of this.panners) panner.dispose()
    for (const moduleGain of this.moduleGains.values()) moduleGain.dispose()
    this.moduleGains.clear()
    this.rowSlots = []
    this.players.length = 0
    this.wideners.length = 0
    this.panners.length = 0
    this.convolver?.dispose()
    this.dry?.dispose()
    this.wet?.dispose()
    this.convolver = null
    this.dry = null
    this.wet = null
  }

  /** Играющие в данный момент источники (по режиму). */
  private activePlayers(): Tone.Player[] {
    if (this.spatial) return this.players
    return this.single ? [this.single] : []
  }

  /** Соло выбранной полосы в 3D-сцене: «Микс» — все семь, полоса — одна. */
  private applyMute(): void {
    if (!this.spatial) return
    const solo = this.source !== 'master'
    this.tracks.forEach((track, index) => {
      const player = this.players[index]
      if (player) player.mute = solo && track.key !== this.source
    })
  }

  /** Параметры пространства по текущим полям (начальная сборка и смена режима). */
  private applySpatialParams(): void {
    if (!this.spatial) return
    this.setWidth(this.widthPct)
    this.setSpread(this.spreadPct)
    this.setWet(this.wetPct)
  }

  /** Длительность — по буферу текущего источника (все файлы одной записи). */
  get duration(): number {
    return this.bufferFor(this.source)?.duration ?? 0
  }

  /** Текущая позиция в времени источника, сек (со скоростью playbackRate). */
  get position(): number {
    if (!this._playing || this.startClock === null) return this.offset
    const elapsed = Math.max(0, Tone.now() - this.startClock) * this.rate
    return Math.min(this.duration, this.offset + elapsed)
  }

  get playing(): boolean {
    return this._playing
  }

  /** Текущий источник (для стора при откате неудачного переключения). */
  get currentSource(): string {
    return this.source
  }

  /**
   * Старт со текущей позиции (с начала — если позиция у края). `Tone.start()`
   * только отсюда: автополитика браузера даёт звук после пользовательского жеста.
   */
  async play(): Promise<void> {
    if (this._playing) return
    const players = this.activePlayers()
    if (players.length === 0) return
    await Tone.start()
    if (this.offset >= this.duration - 0.01) this.offset = 0
    const when = Tone.now() + 0.05
    for (const player of players) player.start(when, this.offset)
    this.startClock = when
    this._playing = true
  }

  /** Пауза: фиксируем позицию (по старой скорости), останавливаем источники. */
  pause(): void {
    if (!this._playing) return
    const position = this.position
    const when = Tone.now()
    for (const player of this.activePlayers()) player.stop(when)
    this.startClock = null
    this.offset = position
    this._playing = false
  }

  /** Стоп: пауза + позиция в начало. */
  stop(): void {
    this.pause()
    this.offset = 0
  }

  /** Перемотка: мгновенно при паузе, перезапуском — при игре. */
  async seek(seconds: number): Promise<void> {
    const target = Math.max(0, Math.min(seconds, this.duration))
    const wasPlaying = this._playing
    if (wasPlaying) this.pause()
    this.offset = target
    if (wasPlaying) await this.play()
  }

  /** Конец трека: сброс к началу (позиция — 0, стоп). */
  finish(): void {
    this.stop()
  }

  /**
   * Скорость (×0.5/×1.0): позиция в времени источника сохраняется, при игре —
   * перестарт (playbackRate нового источника применяется только при старте).
   */
  async setRate(rate: NeuromusicRate): Promise<void> {
    if (rate === this.rate) return
    const wasPlaying = this._playing
    const position = this.position
    if (wasPlaying) this.pause()
    this.rate = rate
    for (const player of this.activePlayers()) player.playbackRate = rate
    this.offset = position
    if (wasPlaying) await this.play()
  }

  /**
   * Выбор источника: «Микс» (мастер, до пост-обработки) или полоса. В 3D-режиме
   * только меняется соло; в обычном — подменяется Player (буфер дозагружается
   * лениво). Позиция и воспроизведение сохраняются.
   */
  async setSource(source: string): Promise<void> {
    if (source === this.source) return
    const urls = this.urlsOf(source)
    if (!urls) throw new Error(`Неизвестный сигнал «${source}»`)
    const wasPlaying = this._playing
    const position = this.position
    if (wasPlaying) this.pause()
    // «Монтаж»: полоса — это 4 рядовых стема, грузятся все (для волны и соло).
    await Promise.all(urls.map((url) => this.loadBuffer(url)))
    this.source = source
    this.offset = Math.min(position, this.duration)
    if (this.spatial) {
      this.applyMute()
    } else {
      this.single?.dispose()
      this.single = null
      this.buildSingle()
    }
    if (wasPlaying) await this.play()
  }

  /**
   * Переключение 3D-режима: новый граф строится после загрузки буферов
   * (старый продолжает лежать в кэше), позиция и воспроизведение сохраняются.
   */
  async setSpatial(spatial: boolean): Promise<void> {
    if (spatial === this.spatial) return
    const wasPlaying = this._playing
    const position = this.position
    if (wasPlaying) this.pause()
    const sourceUrls = this.urlsOf(this.source) ?? []
    const urls = spatial
      ? [...this.tracks.map((track) => track.url), this.irUrl, ...sourceUrls]
      : [...sourceUrls]
    await Promise.all(urls.map((url) => this.loadBuffer(url)))
    this.spatial = spatial
    this.teardownGraph()
    this.buildGraph()
    this.applySpatialParams()
    this.offset = Math.min(position, this.duration)
    if (wasPlaying) await this.play()
  }


  /** Ширина базы (уровень UI 0…150 % → width Tone 0…0.75). */
  setWidth(widthPct: number): void {
    this.widthPct = widthPct
    const width = widthParam(widthPct)
    for (const widener of this.wideners) widener.width.value = width
  }

  /** Разброс по дуге/модулям: плавное (50 мс) переставление источников. */
  setSpread(spreadPct: number): void {
    this.spreadPct = spreadPct
    if (this.panners.length === 0) return
    const spread = spreadParam(spreadPct)
    const arc = sourcePositions(this.tracks.length, spread)
    this.panners.forEach((panner, index) => {
      const track = this.tracks[index]
      const slot = this.rowSlots[index]
      const position =
        track?.row && slot
          ? moduleSourcePosition(track.row, slot.index, slot.count, spread)
          : arc[index]
      panner.positionX.rampTo(position.x, 0.05)
      panner.positionY.rampTo(position.y, 0.05)
      panner.positionZ.rampTo(position.z, 0.05)
    })
  }

  /** Влажность реверберации: линейный dry/wet (0 — только dry). */
  setWet(wetPct: number): void {
    this.wetPct = wetPct
    const wet = wetParam(wetPct)
    this.dry?.gain.rampTo(1 - wet, 0.05)
    this.wet?.gain.rampTo(wet, 0.05)
  }

  /**
   * Смена помещения: IR подгружается и подменяется без остановки игры; вне
   * 3D-режима запоминается до следующей постройки графа.
   */
  async setIrUrl(url: string): Promise<void> {
    this.irUrl = url
    if (!this.spatial || !this.convolver) return
    await this.convolver.load(url)
  }

  /** Полная разборка (смена записи/размонтирование трекера). */
  dispose(): void {
    this.pause()
    this.teardownGraph()
    this.out.dispose()
    this.buffers.clear()
    this.summed.clear()
  }
}
