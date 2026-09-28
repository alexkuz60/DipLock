/**
 * Подпись вьюера: какой слой показывают треки (шаг 2 плана «слои видимости»).
 *
 * Сырой слой — прежняя подпись N14 (вьюер намеренно сырой). Слои «после
 * очистки» и «разница» — **отдельные срезы с явной пометкой**, а не тихая
 * подмена сырого сигнала: сервер собирает их по параметрам стадии «Фильтр и
 * референс» (`GET …/signals?layer=`, лениво и со своим ETag). Числа паспорта
 * фильтра (метод, ядро, краевой буфер) приходят из результата стадии.
 */
import type { SignalLayer } from '@/shared/api/types'
import type { FilterDesign } from '@/shared/state/edfRecording'
import { StatusPill } from '@/shared/ui/StatusPill'

export type ViewerSignalCaptionProps = {
  /** Паспорт фильтра из результата стадии filter (null — стадия не считалась) */
  filterDesign: FilterDesign | null
  /** Активный слой видимости (дефолт raw — демо-кадр и старые места) */
  layer?: SignalLayer
  /** Слой собран по прежним параметрам «Фильтр и референс» (правки после загрузки) */
  stale?: boolean
}

/** Тексты трёх слоёв: подпись всегда называет, что именно на экране. */
const CAPTIONS: Record<SignalLayer, { label: string; title: string }> = {
  raw: {
    label: 'треки: исходный сигнал без фильтра',
    title: 'Треки показывают исходный сигнал записи без фильтра (пирамида сигналов — сырая).',
  },
  cleaned: {
    label: 'треки: после очистки (сигнал расчётов)',
    title:
      'Отдельный срез, а не подмена сырого вьюера: подготовленный сигнал по текущим параметрам ' +
      '«Фильтр и референс» (полоса, notch, референс и очистка) — ровно то, что идёт в расчёт ' +
      'спектра и диполей. Считается лениво, стадию перезапускать не нужно.',
  },
  diff: {
    label: 'треки: разница — вклад очистки',
    title:
      'Отдельный срез: (подготовленный сигнал без очистки) − (с очисткой) на подготовленной ' +
      'базе — что убрала ICA/SSP, гармоники notch и интерполяция bad-каналов. Разница считается ' +
      'по параметрам стадии «Фильтр и референс», без запуска расчёта.',
  },
}

export function ViewerSignalCaption({
  filterDesign,
  layer = 'raw',
  stale = false,
}: ViewerSignalCaptionProps) {
  const detail =
    filterDesign && filterDesign.method !== 'none'
      ? filterDesign.method === 'fir'
        ? `В расчётах FIR, ядро ${filterDesign.lengthSec?.toFixed(2) ?? '?'} с, краевой буфер ±${filterDesign.edgeBufferSec.toFixed(2)} с (эпохи у краёв — BAD_edge)`
        : 'В расчётах IIR (узкая полоса) — края записи не режутся'
      : 'Полоса не задана — расчёты идут по исходному сигналу'
  const caption = CAPTIONS[layer]
  return (
    <>
      <StatusPill
        tone={layer === 'raw' ? 'neutral' : 'accent'}
        title={`${caption.title} ${detail}.`}
      >
        {caption.label}
      </StatusPill>
      {stale && layer !== 'raw' ? (
        <StatusPill
          tone="warn"
          title="Параметры «Фильтр и референс» изменились после загрузки слоя — показаны прежние данные. Обновится при переключении слоя или уровня зума."
        >
          слой по прежним параметрам
        </StatusPill>
      ) : null}
    </>
  )
}