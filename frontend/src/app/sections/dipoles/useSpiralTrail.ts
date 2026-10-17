/**
 * Шлейф спиральных витков раздела «Диполи» (срез 3.11) — общий хук слоя
 * проекций и 3D-вида.
 *
 * Подписка — на **номер эпохи** кадра (`playback.epochIndex`, меняется
 * несколько раз в секунду), а не на 60 fps-контекст и не в разделе (правило
 * `docs/rules/frontend-state.md`: раздел не подписан на время кадра). Источники
 * и пороги — те же, что у кадра анимации (`frameSources`), математика — чистая
 * (`spiralTrailArcs`): оба вида показывают одни и те же витки шлейфа.
 */
import { useMemo } from 'react'
import { frameSources, scanResultOfBand } from '@/shared/lib/dipoleBatch'
import type { DisplayThresholds } from '@/shared/lib/dipolePoints'
import { spiralTrailArcs, type SpiralTrailArc } from '@/shared/lib/spiralTrail'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'

export function useSpiralTrail(): SpiralTrailArc[] {
  const result = useDipoleCalc((state) => state.result)
  const batch = useDipoleCalc((state) => state.batch)
  const playbackBandKeys = useDipoleCalc((state) => state.playbackBandKeys)
  const epochIndex = useDipoleCalc((state) => state.playback.epochIndex)
  const minGofPercent = useDipoleCalc((state) => state.gofThresholdPercent)
  const minAmplitudeNaM = useDipoleCalc((state) => state.amplitudeThresholdNam)

  return useMemo(() => {
    const thresholds: DisplayThresholds = { minGofPercent, minAmplitudeNaM }
    // Длина эпохи — из результата (у пакета — из его первой полосы): окно
    // шлейфа считается во времени сессии, как у шлейфа кадра
    const epochLengthMs =
      result?.epoch_length_ms
      ?? (batch?.bands?.length ? scanResultOfBand(batch, batch.bands[0]).epoch_length_ms : 0)
    return frameSources(result, batch, playbackBandKeys).flatMap((source) =>
      spiralTrailArcs([...source.points.values()], epochIndex, epochLengthMs, thresholds),
    )
  }, [result, batch, playbackBandKeys, epochIndex, minGofPercent, minAmplitudeNaM])
}
