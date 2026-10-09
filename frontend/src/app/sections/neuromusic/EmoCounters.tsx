/**
 * Счётчики «Аккорд» и «Темп» в секции размещения графика «Эмо»
 * (спецификация владельца 09.10.2026, `docs/rules/neuromusic.md`
 * §«Визуализация», «Счётчики»): пиули **справа-сверху**, прибиты к правому
 * краю секции, размер текста — **как у названия раздела в шапке**
 * (`text-lg`; правка 09.10.2026: было `text-2xl`); в подзаголовке секции
 * значения намеренно не размещаются (правка владельца).
 *
 * Значения — **как в анимации радара** (`RadialChart`, уточнение владельца
 * 09.10.2026): темп интерполируется между слайдами (`frameTempos` →
 * `interpolatedTempo`), аккорд — сегмент тональности **активного кадра**
 * анимации (`frameIndexAt` → `activeKeySegment` — тот же источник, что
 * вращение звезды). Нет данных/значение не определено — «—».
 *
 * Обновление — `rAF` пишет `textContent` по ref (паттерн `timeRef` хедера:
 * без ре-рендеров React на каждый кадр, `docs/rules/frontend-perf.md`).
 */
import { useEffect, useMemo, useRef } from 'react'
import type { AudioEmo } from '@/shared/api/types'
import { getActivePlayer } from '@/shared/state/neuromusicPlayer'
import { StatusPill } from '@/shared/ui/StatusPill'
import { frameIndexAt, hopSeconds } from './emoRadar'
import { activeKeySegment } from './keyRotation'
import { formatTempoBpm, frameTempos, interpolatedTempo } from './tempoCorrection'

export type EmoCountersProps = {
  /** Кадры «Эмо» с треками Соник Аннотатора (null — счётчики показывают «—»). */
  emo?: AudioEmo | null
}

/** Пустое значение счётчика: трека нет либо значение не определено. */
const EMPTY = '—'

export function EmoCounters({ emo = null }: EmoCountersProps) {
  // Кадры обязаны быть массивом: защита от ответа не по контракту (как в RadialChart).
  const frames = emo && Array.isArray(emo.frames) ? emo.frames : null
  const hopSec = emo ? hopSeconds(emo.hop_samples, emo.fs_audio) : 0
  // Пофреймовый ряд темпа — тот же, что у метки темпа радара (среднее оценок
  // в диапазоне кадра, hold до следующей). Статика: меняется только с кадрами.
  const tempos = useMemo(
    () => frameTempos(emo?.tempo_track ?? null, frames ?? [], hopSec),
    [emo, frames, hopSec],
  )
  const keyRef = useRef<HTMLSpanElement>(null)
  const tempoRef = useRef<HTMLSpanElement>(null)
  /** Последние записанные тексты — без перезаписи DOM без изменений. */
  const lastRef = useRef({ key: '', tempo: '' })

  useEffect(() => {
    let raf = 0
    const tick = () => {
      const position = getActivePlayer()?.position ?? 0
      // Темп — интерполяция слайдов (как метка темпа радара); нет кадров/сетки
      // либо значение до первой оценки — «—».
      const bpm = frames && hopSec > 0 ? interpolatedTempo(tempos, frames, hopSec, position) : null
      // Аккорд — сегмент активного кадра анимации (источник вращения звезды).
      const frameTime =
        frames && hopSec > 0
          ? (frames[frameIndexAt(position, hopSec, frames.length)]?.t_sec ?? position)
          : position
      const segment = activeKeySegment(emo?.key_track ?? null, frameTime)
      const keyText = segment ? segment.label.trim() || `код ${segment.key_code}` : EMPTY
      const tempoText = bpm != null ? formatTempoBpm(bpm) : EMPTY
      if (keyRef.current && keyText !== lastRef.current.key) {
        keyRef.current.textContent = keyText
        lastRef.current.key = keyText
      }
      if (tempoRef.current && tempoText !== lastRef.current.tempo) {
        tempoRef.current.textContent = tempoText
        lastRef.current.tempo = tempoText
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [emo, frames, hopSec, tempos])

  return (
    <div
      data-testid="emo-counters"
      className="flex w-44 shrink-0 flex-col items-end justify-start gap-2"
    >
      <StatusPill
        tone="neutral"
        title="Аккорд (тональность) по данным Sonic Annotator на позиции плеера"
        className="px-4! py-1.5!"
      >
        <span
          ref={keyRef}
          data-testid="emo-counter-key"
          className="whitespace-nowrap text-lg font-semibold leading-tight"
        >
          {EMPTY}
        </span>
      </StatusPill>
      <StatusPill
        tone="accent"
        title="Темп по данным Sonic Annotator на позиции плеера"
        className="px-4! py-1.5!"
      >
        <span
          ref={tempoRef}
          data-testid="emo-counter-tempo"
          className="whitespace-nowrap text-lg font-semibold leading-tight tabular-nums"
        >
          {EMPTY}
        </span>
      </StatusPill>
    </div>
  )
}