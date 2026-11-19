/**
 * Единый Tone.js-плеер «Нейромузыки» (docs/rules/neuromusic.md, §«Плеер-трекер»;
 * spatial-audio.md, п.1): транспорт, выбор источника, скорость и 3D-цепочка.
 *
 * Граф:
 *  - обычный режим: `Player(выбранный сигнал) → master → destination`;
 *  - 3D «Экспресс»: 7 × `Player → StereoWidener → Panner3D → dry/wet
 *    Convolver → master`;
 *  - «Монтаж» (дипольный рендер, срез 19.11.2026): пространство **запечено в
 *    самих треках** (фазы момента, M/S-ширина, панорама, «колодец» — бэкенд),
 *    поэтому в 3D-режиме треки идут на dry/wet Convolver без повторного
 *    панорамирования (контролы ширины/разброса действуют только на 3D-bake);
 *  - источник «Микс» — вся сцена, полоса — соло, остальные в `mute`
 *    (остаются синхронными).
 *
 * Буферы грузятся ДО построения графа (`load`/`setSource`/`setSpatial`) —
 * reject без осиротевших AudioNode; закэшированные `ToneAudioBuffer`
 * переиспользуются и отдаются трекеру для волны (`bufferFor`). WAV качается
 * кусками по `Range` (`fetchWavChunks`): один ответ на десятки мегабайт не
 * доходит через облачный ingress.
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

/** Строка трека: ключ полосы (из `freq_bands`) и URL WAV. */
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
  /** Вариант рендера: «Монтаж» — стерео уже пространственное (см. граф) */
  variant: 'express' | 'montage'
  /** Ширина стереобазы, % (100 — без изменения) */
  widthPct: number
  /** Разброс по дуге, % (100 — ±60°) */
  spreadPct: number
  /** Влажность реверберации, % (0 — сухой сигнал) */
  wetPct: number
  /** Прогресс докачки WAV (байты) — трекер показывает проценты загрузки */
  onProgress?: WavProgress
}

/** Размер куска докачки WAV: один ответ на 30 МБ не доходит через ingress. */
export const WAV_CHUNK_BYTES = 4 * 1024 * 1024
/** Попыток на кусок: облачный прокси рвёт длинные ответы, повтор лечит. */
const CHUNK_ATTEMPTS = 2
/**
 * Параллельных кусков: последовательная докачка 30 МБ через Cloudflare
 * занимает минуты (замер 18.11.2026 — 2.2 МБ/с на один поток), четыре
 * потока сокращают ожидание почти вчетверо. Порядок склейки не зависит от
 * порядка ответов — куски раскладываются по индексам.
 */
const CHUNK_CONCURRENCY = 4

/** Прогресс докачки: сколько байт уже получено из сколько всего. */
export type WavProgress = (loaded: number, total: number) => void

/** Размер файла из `Content-Range: bytes a-b/total`. */
function totalOf(response: Response): number {
  const header = response.headers.get('content-range') ?? ''
  const total = Number(header.split('/')[1])
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error('сервер не сообщил размер файла (Content-Range)')
  }
  return total
}

/** Один кусок с повтором на сетевой сбой и 5xx; 4xx — сразу наверх. */
async function fetchChunk(url: string, start: number, end: number): Promise<Response> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
      if (response.ok || response.status === 416) return response
      lastError = new Error(`HTTP ${response.status}`)
      if (response.status < 500) break
    } catch (cause) {
      lastError = cause
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * Качает WAV кусками по `Range` (до 4 параллельно) и склеивает в `ArrayBuffer`.
 *
 * Мастер рендера — десятки мегабайт (48 кГц, PCM_24, стерео): один такой ответ
 * через облачный ingress (Cloudflare + Envoy) обрывается, и `fetch` падает
 * `NetworkError`. Куски по 4 МиБ проходят, повтор лечит разовый обрыв, а
 * параллельные потоки сокращают ожидание. Сервер без поддержки `Range`
 * отвечает `200` — тело берётся целиком.
 */
export async function fetchWavChunks(
  url: string,
  onProgress?: WavProgress,
): Promise<ArrayBuffer> {
  const first = await fetchChunk(url, 0, WAV_CHUNK_BYTES - 1)
  if (first.status === 200) {
    const body = await first.arrayBuffer()
    onProgress?.(body.byteLength, body.byteLength)
    return body
  }
  if (first.status !== 206) throw new Error(`HTTP ${first.status}`)
  const total = totalOf(first)
  const parts: Uint8Array[] = [new Uint8Array(await first.arrayBuffer())]
  let received = parts[0].byteLength
  onProgress?.(received, total)
  const ranges: Array<[number, number]> = []
  for (let start = received; start < total; start += WAV_CHUNK_BYTES) {
    ranges.push([start, Math.min(start + WAV_CHUNK_BYTES, total) - 1])
  }
  const tail = new Array<Uint8Array>(ranges.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let index = next++; index < ranges.length; index = next++) {
      const [start, end] = ranges[index]
      const response = await fetchChunk(url, start, end)
      if (response.status !== 206) {
        throw new Error(`HTTP ${response.status} (кусок ${start}-${end})`)
      }
      const part = new Uint8Array(await response.arrayBuffer())
      if (part.byteLength === 0) throw new Error(`пустой кусок ${start}-${end}`)
      tail[index] = part
      received += part.byteLength
      onProgress?.(received, total)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CHUNK_CONCURRENCY, ranges.length) }, worker),
  )
  const merged = new Uint8Array(received)
  let offset = 0
  for (const part of [...parts, ...tail]) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return merged.buffer
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
  private readonly variant: 'express' | 'montage'
  private widthPct: number
  private spreadPct: number
  private wetPct: number
  /** Прогресс докачки WAV — общий для старта, смены источника и 3D-графа. */
  private readonly onProgress: WavProgress | undefined

  /** Общий выход графа: создаётся один раз, переживает перестройки режима. */
  private readonly out: Tone.Gain
  /** Обычный режим: единственный играющий сигнал (буфер полосы/мастера). */
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
    this.variant = options.variant
    this.widthPct = options.widthPct
    this.spreadPct = options.spreadPct
    this.wetPct = options.wetPct
    this.onProgress = options.onProgress
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
   * URL сигнала: 'master' → мастер, иначе — URL трека полосы;
   * `null` — неизвестный сигнал.
   */
  private urlsOf(source: string): string[] | null {
    if (source === 'master') return [this.masterUrl]
    const urls = this.tracks.filter((track) => track.key === source).map((track) => track.url)
    return urls.length > 0 ? urls : null
  }

  /** Загрузка одного WAV кусками по `Range` с кэшем; reject — HTTP/декод. */
  private async loadBuffer(
    url: string,
    onProgress: WavProgress | undefined = this.onProgress,
  ): Promise<Tone.ToneAudioBuffer> {
    const cached = this.buffers.get(url)
    if (cached) return cached
    try {
      const arrayBuffer = await fetchWavChunks(url, onProgress)
      const audioBuffer = await Tone.getContext().decodeAudioData(arrayBuffer)
      const buffer = new Tone.ToneAudioBuffer(audioBuffer)
      this.buffers.set(url, buffer)
      return buffer
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      throw new Error(`Не удалось загрузить аудио «${url}»: ${message}`)
    }
  }

  /**
   * Буфер сигнала для отрисовки волны (сухой сигнал до любых эффектов):
   * `null` — буфер ещё не загружен (загрузка идёт, трекер показывает пустоту).
   */
  bufferFor(source: string): Tone.ToneAudioBuffer | null {
    const urls = this.urlsOf(source)
    if (!urls || urls.length === 0) return null
    return this.buffers.get(urls[0]) ?? null
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

  /**
   * 3D-режим: «Экспресс» — стемы на дуге (StereoWidener + Panner3D),
   * «Монтаж» — стерео уже пространственное (запечено бэкендом), треки идут
   * сразу на dry/wet Convolver без повторного панорамирования.
   */
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
    this.tracks.forEach((track, index) => {
      const buffer = this.buffers.get(track.url)
      if (!buffer) throw new Error(`Трек «${track.key}» не загружен`)
      const player = new Tone.Player(buffer)
      player.playbackRate = this.rate
      if (this.variant === 'montage') {
        // Пространство запечено в треке (фазы/ширина/панорама/«колодец»):
        // только общая реверберация помещения, без panner/ширины.
        player.connect(dry)
        player.connect(convolver)
        this.players.push(player)
        return
      }
      const widener = new Tone.StereoWidener(widthParam(this.widthPct))
      const position = arc[index]
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

  /** Разброс по дуге: плавное (50 мс) переставление источников. */
  setSpread(spreadPct: number): void {
    this.spreadPct = spreadPct
    if (this.panners.length === 0) return
    const spread = spreadParam(spreadPct)
    const arc = sourcePositions(this.tracks.length, spread)
    this.panners.forEach((panner, index) => {
      const position = arc[index]
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
  }
}
