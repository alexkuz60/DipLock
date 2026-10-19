/**
 * Строка выделенного диполя: подпись выбора («Выделен диполь: …») и кнопка
 * «Снять выделение».
 *
 * Клик по точке в любой проекции выделяет её во всех трёх (`selectedPointId` в
 * `shared/state/dipoleCalc.ts`). Строка нужна, чтобы у выбора была читаемая
 * подпись (а не только подсветка на фигуре) и чтобы выделение можно было снять,
 * не попав мышью в ту же точку.
 *
 * С 19.10.2026 строка живёт в секции «Локализация» панели «Опции» (перенос из
 * рабочей области: она показывает только фигуры и результат). Точки берутся из
 * того же слоя, что рисуют проекции (`useDipoleLayer`), — подпись обязана
 * описывать тот диполь, который видно на фигуре, а не «похожий». Тултип пилюли
 * убран: он дословно повторял её текст.
 *
 * Выделенный диполь ищем в **полном** слое, а не в отфильтрованном порогами:
 * пороги отображения управляют только отрисовкой, и уже выделенная точка не
 * должна «теряться» из подписи при подъёме порога.
 */
import { useMemo } from 'react'
import {
  type DisplayThresholds,
  dipolePointTitle,
  thresholdDipoleLayer,
  withOverlapCounts,
} from '@/shared/lib/dipolePoints'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { Button } from '@/shared/ui/Button'
import { StatusPill } from '@/shared/ui/StatusPill'
import { useDipoleLayer } from './useDipoleLayer'

export function SelectedDipoleLine() {
  const layer = useDipoleLayer()
  const minGofPercent = useDipoleCalc((state) => state.gofThresholdPercent)
  const minAmplitudeNaM = useDipoleCalc((state) => state.amplitudeThresholdNam)
  const selectedPointId = useDipoleCalc((state) => state.selectedPointId)
  const clearSelectedPoint = useDipoleCalc((state) => state.clearSelectedPoint)

  /** Пороги отображения (GOF % и момент нА·м) — то же правило, что у проекций */
  const thresholds: DisplayThresholds = useMemo(
    () => ({ minGofPercent, minAmplitudeNaM }),
    [minGofPercent, minAmplitudeNaM],
  )
  /**
   * Кратность узла для подписи берётся из слоя отрисовки (с учётом порога): если
   * диполь скрыт порогом, числа диполей в узле не показываем — «1» было бы
   * выдумкой, а «3» не совпало бы с картинкой.
   */
  const displayLayer = useMemo(
    () => withOverlapCounts(thresholdDipoleLayer(layer, thresholds)),
    [layer, thresholds],
  )

  const selected = selectedPointId
    ? (layer.points.find((point) => point.id === selectedPointId) ?? null)
    : null
  const selectedOverlap = selected
    ? displayLayer.points.find((point) => point.id === selected.id)?.overlapCount
    : undefined
  const selectedTitle = selected
    ? dipolePointTitle(
        selectedOverlap === undefined ? selected : { ...selected, overlapCount: selectedOverlap },
      )
    : ''

  if (!selected) return null

  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusPill tone="accent">{`Выделен диполь: ${selectedTitle}`}</StatusPill>
      <Button onClick={clearSelectedPoint} title="Снять выделение со всех проекций">
        Снять выделение
      </Button>
    </div>
  )
}