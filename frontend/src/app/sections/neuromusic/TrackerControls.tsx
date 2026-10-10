/**
 * Элементы управления плеером «Нейромузыки» в хедере раздела: источник
 * сигнала, горизонтальный зум, скорость и таймкод «позиция / длительность» —
 * слева от кнопок транспорта Play/Stop (docs/rules/neuromusic.md,
 * §«Плеер-трекер»; приёмка 07.10.2026 — контролы покинули трекер).
 *
 * Видимой подписи «Сигнал» у комбо больше нет (экономия места в шапке,
 * правка 10.10.2026) — у списка остаётся `aria-label="Сигнал"`.
 *
 * Позиция в стор не кладётся: таймкод пишет rAF-цикл трекера через общий
 * `trackerTimeRef` (textContent, без ре-рендеров хедера — правило
 * `docs/rules/frontend-perf.md`).
 */
import {
  PLAYBACK_RATES,
  TIME_ZOOMS,
  type PlaybackRate,
  type TimeZoom,
} from '@/shared/lib/waveformView'
import { MASTER_SOURCE, useNeuromusicPlayer } from '@/shared/state/neuromusicPlayer'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { SelectField } from '@/shared/ui/SelectField'
import { MIX_LABEL, bandLabel, sortBandsByFrequency } from './bandLabels'
import { trackerTimeRef } from './trackerTimeRef'

export type TrackerControlsProps = {
  /** Ключи полос в порядке партитуры — в комбо идут по возрастанию частоты */
  tracks: string[]
}

export function TrackerControls({ tracks }: TrackerControlsProps) {
  const source = useNeuromusicPlayer((state) => state.source)
  const zoom = useNeuromusicPlayer((state) => state.zoom)
  const rate = useNeuromusicPlayer((state) => state.rate)
  const ready = useNeuromusicPlayer((state) => state.ready)
  const loading = useNeuromusicPlayer((state) => state.loading)

  return (
    <>
      <SelectField
        layout="inline"
        label="Сигнал"
        value={source}
        options={[
          { value: MASTER_SOURCE, label: MIX_LABEL },
          ...sortBandsByFrequency(tracks).map((key) => ({
            value: key,
            label: bandLabel(key),
          })),
        ]}
        onChange={(value) => void useNeuromusicPlayer.getState().setSource(value)}
        disabled={!ready || loading}
      />
      <SegmentedControl
        layout="inline"
        label="Зум"
        value={String(zoom)}
        options={TIME_ZOOMS.map((value) => ({
          value: String(value),
          label: `×${value}`,
          title:
            value === 1
              ? 'Весь файл целиком'
              : `Окно 1/${value} файла — детали вокруг позиционера`,
        }))}
        onChange={(value) => useNeuromusicPlayer.getState().setZoom(Number(value) as TimeZoom)}
      />
      <SegmentedControl
        layout="inline"
        label="Скорость"
        value={String(rate)}
        options={PLAYBACK_RATES.map((value) => ({
          value: String(value),
          label: `×${value}`,
          title:
            value === 0.5
              ? 'Замедление для слухового контроля (в итоговый файл не попадает, высота тона ниже)'
              : 'Нормальная скорость',
        }))}
        onChange={(value) =>
          void useNeuromusicPlayer.getState().setRate(Number(value) as PlaybackRate)
        }
      />
      <span
        ref={trackerTimeRef}
        data-testid="tracker-time"
        className="text-sm tabular-nums text-fg-2"
      >
        0:00 / 0:00
      </span>
    </>
  )
}