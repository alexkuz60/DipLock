/**
 * Навигация по окну и зум раздела «ЭЭГ» в тулс-хедере.
 *
 * Общая разметка — `shared/ui/ZoomNavControls` (тот же контрол, что в EDF), а
 * состояние у раздела своё: уровень зума и режим навигатора в `eegParams`
 * (расчёт от них не устаревает), шаг режима «Навигация» — `artifactNav`,
 * команда листания — через `eegNav` с монотонным `seq`, потому что окно раздела
 * живёт в состоянии, а не в компоненте: его видят обе половины.
 */
import { useEegParams } from '@/shared/state/eegParams'
import { ZoomNavControls } from '@/shared/ui/ZoomNavControls'

export function EegWindowControls() {
  const level = useEegParams((state) => state.params.timeLevel)
  const navMode = useEegParams((state) => state.params.navMode)
  const step = useEegParams((state) => state.artifactNav)
  const setParams = useEegParams((state) => state.setParams)
  const requestNav = useEegParams((state) => state.requestNav)

  return (
    <ZoomNavControls
      timeLevel={level}
      navMode={navMode}
      step={step}
      onTimeLevel={(next) => setParams({ timeLevel: next })}
      onNav={requestNav}
      zoomLabel="Зум окна ЭЭГ и спектрограммы"
      zoomTitle="Масштаб по времени: ×1 — вся сессия, ×16 — максимальное приближение (действует на обе половины)"
    />
  )
}
