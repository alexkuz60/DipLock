/**
 * Подпись вьюера: треки показывают исходный сигнал без фильтра (N14, шаг 2.5).
 *
 * Пирамида сигналов (`recording_signals`) намеренно отдаёт запись сырой: фильтр —
 * параметр расчёта, а не просмотра (раньше это молчало, и треки выглядели
 * отфильтрованными). Пилюля стоит в шапке треков рядом с «слои:»; числа (метод,
 * ядро, краевой буфер) приходят из результата стадии «Фильтр и референс».
 */
import type { FilterDesign } from '@/shared/state/edfRecording'
import { StatusPill } from '@/shared/ui/StatusPill'

export type ViewerSignalCaptionProps = {
  /** Паспорт фильтра из результата стадии filter (null — стадия не считалась) */
  filterDesign: FilterDesign | null
}

export function ViewerSignalCaption({ filterDesign }: ViewerSignalCaptionProps) {
  const detail =
    filterDesign && filterDesign.method !== 'none'
      ? filterDesign.method === 'fir'
        ? `В расчётах FIR, ядро ${filterDesign.lengthSec?.toFixed(2) ?? '?'} с, краевой буфер ±${filterDesign.edgeBufferSec.toFixed(2)} с (эпохи у краёв — BAD_edge)`
        : 'В расчётах IIR (узкая полоса) — края записи не режутся'
      : 'Полоса не задана — расчёты идут по исходному сигналу'
  return (
    <StatusPill
      tone="neutral"
      title={`Треки показывают исходный сигнал записи без фильтра (пирамида сигналов — сырая). ${detail}.`}
    >
      треки: исходный сигнал без фильтра
    </StatusPill>
  )
}