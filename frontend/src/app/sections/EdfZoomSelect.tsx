/**
 * Навигация по окну и комбо-бокс зума отрисовки ЭЭГ в тулс-хедере раздела EDF.
 *
 * Разметка и поведение живут в `shared/ui/ZoomNavControls.tsx` (срез 5 вынес их
 * ради раздела «ЭЭГ», чтобы второй такой же контрол не разошёлся с первым):
 * здесь только подписи раздела и источник состояния — уровень зума и режим
 * навигатора из `edfParams`, шаг режима «Навигация» и команда листания через
 * стор записи (`artifactNav`, `requestNav`), потому что центр окна — локальное
 * состояние вьюера (`TrackStack`), а не панели.
 */
import { useEdfParams } from '@/shared/state/edfParams'
import { useEdfRecording } from '@/shared/state/edfRecording'
import { ZoomNavControls } from '@/shared/ui/ZoomNavControls'

export function EdfZoomSelect() {
  const level = useEdfParams((state) => state.params.timeLevel)
  const navMode = useEdfParams((state) => state.params.navMode)
  const setParams = useEdfParams((state) => state.setParams)
  const requestNav = useEdfRecording((state) => state.requestNav)
  const artifactNav = useEdfRecording((state) => state.artifactNav)

  return (
    <ZoomNavControls
      timeLevel={level}
      navMode={navMode}
      step={artifactNav}
      onTimeLevel={(next) => setParams({ timeLevel: next })}
      onNav={requestNav}
      zoomLabel="Зум отрисовки ЭЭГ"
      zoomTitle="Масштаб по времени: ×1 — вся сессия, ×16 — максимальное приближение"
    />
  )
}
