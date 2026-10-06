/**
 * Пространственный плеер «Нейромузыки» — real-time цепочка на Tone.js
 * (docs/rules/spatial-audio.md, п.1; вердикт владельца 06.10.2026).
 *
 * Цепочка на каждый из 7 стемов: `Player → StereoWidener → Panner3D`,
 * затем шина → dry/wet (`Convolver` с IR из `/audio/ir/{id}.wav`) → master.
 * Синхронизация стемов — общий момент старта в аудио-контексте (семпл-точная:
 * все источники планируются на одно и то же время AudioContext).
 *
 * Правило UI не нарушается: параметры (ширина/разброс/влажность/помещение)
 * применяются к живому графу мгновенно и не порождают ни POST, ни пересчёта
 * рендера — это и есть критерий среза «real-time эксперимент».
 *
 * Буферы грузятся ДО построения графа (`load`): ошибка загрузки — reject без
 * осиротевших AudioNode; загруженные `ToneAudioBuffer` передаются в Player и
 * Convolver (без второй загрузки тех же URL).
 */
import * as Tone from 'tone'
import {
  SOURCE_DISTANCE_M,
  sourcePositions,
  spreadParam,
  widthParam,
  wetParam,
} from './spatialLayout'

export type SpatialPlayerOptions = {
  /** URL WAV-стемов (7 полос), порядок — как в `status.tracks` */
  trackUrls: string[]
  /** URL WAV импульсной характеристики (пресет из `GET /audio/ir`) */
  irUrl: string
  /** Ширина базы, % (100 — без изменения) */
  widthPct: number
  /** Разброс по дуге, % (100 — полная дуга ±60°) */
  spreadPct: number
  /** Влажность реверберации, % (0 — сухой сигнал) */
  wetPct: number
}

/**
 * Плеер с пространственной обработкой. Экземпляр создаётся один раз на рендер
 * (`load`), уничтожается при смене записи/выключении режима (`dispose`).
 */
export class SpatialAudioPlayer {
  private readonly players: Tone.Player[] = []
  private readonly wideners: Tone.StereoWidener[] = []
  private readonly panners: Tone.Panner3D[] = []
  private readonly convolver: Tone.Convolver
  private readonly dryGain: Tone.Gain
  private readonly wetGain: Tone.Gain
  private readonly master: Tone.Gain
  /** Момент старта текущего проигрывания (аудио-контекст, сек) */
  private startClock: number | null = null
  /** Запомненная позиция между play/pause, сек */
  private offset = 0
  private _playing = false

  private constructor(
    trackBuffers: Tone.ToneAudioBuffer[],
    irBuffer: Tone.ToneAudioBuffer,
    spreadPct: number,
  ) {
    const positions = sourcePositions(trackBuffers.length, spreadParam(spreadPct))

    // IR уже загружен (irBuffer) — Convolver не делает второй fetch.
    this.convolver = new Tone.Convolver({ url: irBuffer, normalize: true })
    this.dryGain = new Tone.Gain(1)
    this.wetGain = new Tone.Gain(0)
    this.master = new Tone.Gain(1).toDestination()

    this.dryGain.connect(this.master)
    this.convolver.connect(this.wetGain)
    this.wetGain.connect(this.master)

    trackBuffers.forEach((buffer, index) => {
      const player = new Tone.Player(buffer)
      const widener = new Tone.StereoWidener(widthParam(100))
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
      panner.connect(this.dryGain)
      panner.connect(this.convolver)
      this.players.push(player)
      this.wideners.push(widener)
      this.panners.push(panner)
    })
  }

  /**
   * Грузит все буферы (стемы + IR) и строит граф; начальные параметры
   * применяются сеттерами — один путь с real-time обновлениями из UI.
   */
  static async load(options: SpatialPlayerOptions): Promise<SpatialAudioPlayer> {
    const buffers = await Promise.all(
      [...options.trackUrls, options.irUrl].map((url) => loadBuffer(url)),
    )
    const trackBuffers = buffers.slice(0, options.trackUrls.length)
    const irBuffer = buffers[buffers.length - 1]
    const player = new SpatialAudioPlayer(trackBuffers, irBuffer, options.spreadPct)
    player.setWidth(options.widthPct)
    player.setWet(options.wetPct)
    return player
  }

  /** Длительность — по самому длинному стему (все треки одной записи). */
  get duration(): number {
    return this.players.reduce((max, player) => Math.max(max, player.buffer.duration), 0)
  }

  /** Текущая позиция, сек (запомненная + время проигрывания). */
  get position(): number {
    if (!this._playing || this.startClock === null) return this.offset
    return Math.min(this.duration, this.offset + Math.max(0, Tone.now() - this.startClock))
  }

  get playing(): boolean {
    return this._playing
  }

  /** Старт со всех позиций: от текущей (или с начала, если это конец). */
  async play(): Promise<void> {
    if (this._playing) return
    // Автополитика браузера: контекст стартует только из пользовательского жеста.
    await Tone.start()
    if (this.offset >= this.duration - 0.01) this.offset = 0
    const when = Tone.now() + 0.05
    for (const player of this.players) player.start(when, this.offset)
    this.startClock = when
    this._playing = true
  }

  /** Пауза: фиксируем позицию, останавливаем все стемы одним моментом. */
  pause(): void {
    if (!this._playing) return
    const position = this.position
    const when = Tone.now()
    for (const player of this.players) player.stop(when)
    this.startClock = null
    this.offset = position
    this._playing = false
  }

  /** Перемотка: мгновенно при паузе, перезапуском — при игре. */
  async seek(seconds: number): Promise<void> {
    const target = Math.max(0, Math.min(seconds, this.duration))
    if (this._playing) {
      this.pause()
      this.offset = target
      await this.play()
    } else {
      this.offset = target
    }
  }

  /** Конец проигрывания: сброс к началу (позиция — 0, стоп). */
  finish(): void {
    this.pause()
    this.offset = 0
  }

  /** Ширина базы (уровень UI 0…150 % → width Tone 0…0.75). */
  setWidth(widthPct: number): void {
    const width = widthParam(widthPct)
    for (const widener of this.wideners) widener.width.value = width
  }

  /** Разброс по дуге: плавное (50 мс) переставление источников. */
  setSpread(spreadPct: number): void {
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
    const wet = wetParam(wetPct)
    this.dryGain.gain.rampTo(1 - wet, 0.05)
    this.wetGain.gain.rampTo(wet, 0.05)
  }

  /** Смена помещения: IR подгружается и подменяется без остановки игры. */
  async setIrUrl(url: string): Promise<void> {
    await this.convolver.load(url)
  }

  /** Полная разборка графа (смена записи/выключение режима). */
  dispose(): void {
    this.pause()
    for (const player of this.players) player.dispose()
    for (const widener of this.wideners) widener.dispose()
    for (const panner of this.panners) panner.dispose()
    this.convolver.dispose()
    this.dryGain.dispose()
    this.wetGain.dispose()
    this.master.dispose()
    this.players.length = 0
    this.wideners.length = 0
    this.panners.length = 0
  }
}

/** Загрузка одного WAV через Tone (fetch + decode); reject — HTTP/декодирование. */
function loadBuffer(url: string): Promise<Tone.ToneAudioBuffer> {
  return new Promise((resolve, reject) => {
    const buffer = new Tone.ToneAudioBuffer(
      url,
      () => resolve(buffer),
      (error) => reject(new Error(`Не удалось загрузить аудио «${url}»: ${error.message}`)),
    )
  })
}
