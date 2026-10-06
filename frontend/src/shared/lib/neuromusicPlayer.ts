/**
 * Единый Tone.js-плеер «Нейромузыки» (docs/rules/neuromusic.md, §«Плеер-трекер»;
 * spatial-audio.md, п.1): транспорт, выбор источника, скорость и 3D-цепочка.
 *
 * Граф:
 *  - обычный режим: `Player(выбранный сигнал) → master → destination`;
 *  - 3D-режим: 7 × `Player → StereoWidener → Panner3D → dry/wet Convolver →
 *    master`; источник «Микс» — вся сцена, полоса — соло (остальные стемы
 *    в `mute`, остаются синхронными по времени).
 *
 * Буферы грузятся ДО построения графа (`load`/`setSource`/`setSpatial`) —
 * reject без осиротевших AudioNode; закэшированные `ToneAudioBuffer`
 * переиспользуются и отдаются трекеру для волны (`bufferFor`).
 *
 * Скорость — только `player.playbackRate` (×0.5 для слухового контроля быстрых
 * перемещений; в результат не попадает, питч при замедлении падает — допустимо,
 * уточнение владельца 06.10.2026). Смена скорости — перестарт с той же позиции.
 */
import * as Tone from 'tone'
import {
  SOURCE_DISTANCE_M,
  sourcePositions,
  spreadParam,
  widthParam,
  wetParam,
} from './spatialLayout'

/** Скорость воспроизведения: только замедление (×0.5 / ×1.0). */
export type NeuromusicRate = 0.5 | 1

/** Строки трека: ключ полосы (из `freq_bands`) и URL его WAV. */
export type NeuromusicTrack = { key: string; url: string }

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
  /** Обычный режим: единственный играющий сигнал */
  private single: Tone.Player | null = null
  /** 3D-режим */
  private readonly players: Tone.Player[] = []
  private readonly wideners: Tone.StereoWidener[] = []
  private readonly panners: Tone.Panner3D[] = []
  private convolver: Tone.Convolver | null = null
  private dry: Tone.Gain | null = null
  private wet: Tone.Gain | null = null

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
    const sourceUrl = player.urlOf(options.source)
    if (sourceUrl) urls.add(sourceUrl)
    if (options.spatial) {
      for (const track of options.tracks) urls.add(track.url)
      urls.add(options.irUrl)
    }
    await Promise.all([...urls].map((url) => player.loadBuffer(url)))
    player.buildGraph()
    player.applySpatialParams()
    return player
  }

  /** URL сигнала: 'master' → мастер, иначе полоса; неизвестный ключ → null. */
  private urlOf(source: string): string | null {
    if (source === 'master') return this.masterUrl
    return this.tracks.find((track) => track.key === source)?.url ?? null
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
   */
  bufferFor(source: string): Tone.ToneAudioBuffer | null {
    const url = this.urlOf(source)
    return (url ? this.buffers.get(url) : null) ?? null
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

  /** 3D-режим: 7 стемов на дуге → dry/wet Convolver → master. */
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

    const positions = sourcePositions(this.tracks.length, spreadParam(this.spreadPct))
    this.tracks.forEach((track, index) => {
      const buffer = this.buffers.get(track.url)
      if (!buffer) throw new Error(`Трек «${track.key}» не загружен`)
      const player = new Tone.Player(buffer)
      player.playbackRate = this.rate
      const widener = new Tone.StereoWidener(widthParam(this.widthPct))
      const panner = new Tone.Panner3D({
        panningModel: 'HRTF',
        distanceModel: 'inverse',
        refDistance: SOURCE_DISTANCE_M,
        rolloffFactor: 1,
        positionX: positions[index].x,
        positionY: positions[index].y,
        positionZ: positions[index].z,
      })
      player.connect(widener)
      widener.connect(panner)
      panner.connect(dry)
      panner.connect(convolver)
      this.players.push(player)
      this.wideners.push(widener)
      this.panners.push(panner)
    })
    this.applyMute()
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
    const url = this.urlOf(source)
    if (!url) throw new Error(`Неизвестный сигнал «${source}»`)
    const wasPlaying = this._playing
    const position = this.position
    if (wasPlaying) this.pause()
    await this.loadBuffer(url)
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
    const sourceUrl = this.urlOf(this.source)
    const urls = spatial
      ? [...this.tracks.map((track) => track.url), this.irUrl, ...(sourceUrl ? [sourceUrl] : [])]
      : [...(sourceUrl ? [sourceUrl] : [])]
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

  /** Разброс по дуге: плавное (50 мс) переставление источников. */
  setSpread(spreadPct: number): void {
    this.spreadPct = spreadPct
    if (this.panners.length === 0) return
    const positions = sourcePositions(this.panners.length, spreadParam(spreadPct))
    this.panners.forEach((panner, index) => {
      const { x, y, z } = positions[index]
      panner.positionX.rampTo(x, 0.05)
      panner.positionY.rampTo(y, 0.05)
      panner.positionZ.rampTo(z, 0.05)
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
  }
}
