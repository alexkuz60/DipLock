/**
 * Навигация по окну и комбо-бокс зума отрисовки ЭЭГ в тулс-хедере раздела EDF.
 *
 * Разметка и поведение живут в `shared/ui/ZoomNavControls.tsx` (срез 5 вынес их
 * ради раздела «ЭЭГ», чтобы второй такой же контрол не разошёлся с первым):
 * здесь только подписи раздела и источник состояния — уровень зума из
 * `edfParams`, команда листания через стор записи (`requestNav`), потому что
 * центр окна — локальное состояние вьюера (`TrackStack`), а не панели.
 */
import { useEdfParams } from '@/shared/state/edfParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { ZoomNavControls } from '@/shared/ui/ZoomNavControls'

export function EdfZoomSelect() {
  const level = useEdfParams((state) => state.params.timeLevel)
  const setParams = useEdfParams((state) => state.setParams)
  const requestNav = useEdfRecording((state) => state.requestNav)

  return (
    <ZoomNavControls
      timeLevel={level}
      onTimeLevel={(next) => setParams({ timeLevel: next })}
      onNav={requestNav}
      zoomLabel="Зум отрисовки ЭЭГ"
      zoomTitle="Масштаб по времени: ×1 — вся сессия, ×16 — максимальное приближение"
    />
  )
}
