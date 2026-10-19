/**
 * Слой диполей раздела «Диполи» из результата задачи — единый источник точек для
 * рабочей области (проекции/3D) и секции «Локализация» панели «Опции» (подпись
 * выделенного диполя).
 *
 * У пакета (С1) облако — точки **всех отмеченных полос** (`playbackBandKeys`) в
 * полосных цветах (п.1.4 17.10.2026); одиночный расчёт — слой своего результата.
 * Результат не пересчитывается на клиенте: смена порогов отображения меняет только
 * **отрисовку** (какие точки рисовать), поэтому слой строится из результата и
 * фильтруется порогами отдельной чистой функцией. Пороги (GOF % — основной,
 * момент нА·м — дополнительный) — параметры отображения, а «КД» (вердикт
 * `kd_passed`) — параметр анализа (С0).
 *
 * Общий хук держит инвариант «подпись описывает те же точки, что видно на
 * проекциях»: рабочая область и строка выделения не могут разойтись.
 */
import { useMemo } from 'react'
import { batchDipoleLayer } from '@/shared/lib/dipoleBatch'
import {
  type DipoleLayer,
  dipoleLayerFromScan,
  emptyDipoleLayer,
} from '@/shared/lib/dipolePoints'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'

/**
 * Пустой слой диполей — общий объект на все рендеры: раздел не имитирует расчёт,
 * а постоянная ссылка не сбрасывает мемоизацию маркеров каждый рендер.
 */
const EMPTY_DIPOLE_LAYER = emptyDipoleLayer()

export function useDipoleLayer(): DipoleLayer {
  const result = useDipoleCalc((state) => state.result)
  const batch = useDipoleCalc((state) => state.batch)
  const playbackBandKeys = useDipoleCalc((state) => state.playbackBandKeys)

  return useMemo(() => {
    if (batch) return batchDipoleLayer(batch, playbackBandKeys)
    return result ? dipoleLayerFromScan(result) : EMPTY_DIPOLE_LAYER
  }, [batch, playbackBandKeys, result])
}