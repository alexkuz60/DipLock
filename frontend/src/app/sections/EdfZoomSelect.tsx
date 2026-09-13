/**
 * Комбо-бокс зума отрисовки ЭЭГ в тулс-хедере раздела EDF.
 *
 * Дублирует колесо мыши и контрол панели, но всегда под рукой: уровень — это
 * индекс в `TIME_LEVELS` (×1 — вся сессия … ×16). Правка ничего не запускает:
 * зум — параметр отрисовки, расчёт от него не устаревает.
 */
import { ZoomIn } from 'lucide-react'
import { TIME_LEVELS, useEdfParams } from '@/shared/state/edfParams'

export function EdfZoomSelect() {
  const level = useEdfParams((state) => state.params.timeLevel)
  const setParams = useEdfParams((state) => state.setParams)

  return (
    <label className="flex items-center gap-2 text-sm text-fg-2">
      <ZoomIn className="size-4 shrink-0" aria-hidden />
      <select
        aria-label="Зум отрисовки ЭЭГ"
        title="Масштаб по времени: ×1 — вся сессия, ×16 — максимальное приближение"
        value={String(level)}
        onChange={(event) => setParams({ timeLevel: Number(event.target.value) })}
        className="tnum rounded-lg border border-border bg-bg-2 px-2 py-1.5 text-sm text-fg-0"
      >
        {TIME_LEVELS.map((factor, index) => (
          <option key={factor} value={index}>
            ×{factor}
            {index === 0 ? ' (вся сессия)' : ''}
          </option>
        ))}
      </select>
    </label>
  )
}
