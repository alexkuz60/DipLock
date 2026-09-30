/**
 * Комбо-списки слоя сигнала и полосы в подзаголовке секции «Треки записи».
 *
 * Дубль секций «Слой сигнала»/«Полоса слоя» панели «Отображение» (просьба
 * владельца 30.09.2026): тот же параметр `edfParams` (`signalLayer` /
 * `signalBandKey`), те же `SIGNAL_LAYER_OPTIONS` и `bandKeyOptions(meta)` —
 * переключение меняет только вид треков, расчёт не запускается и не
 * устаревает (правило `docs/rules/frontend-state.md`), а списки двух мест
 * не разойтись, потому что сборка пунктов одна. «Полоса» показывается только
 * у слоя «По полосе» — как и в панели.
 */
import { SIGNAL_LAYER_OPTIONS, useEdfParams } from '@/shared/state/edfParams'
import type { BandKeyOption } from '@/shared/lib/bandOptions'
import { SelectField } from '@/shared/ui/SelectField'

export function TrackHeaderControls({ bandOptions }: { bandOptions: BandKeyOption[] }) {
  const layer = useEdfParams((state) => state.params.signalLayer)
  const bandKey = useEdfParams((state) => state.params.signalBandKey)
  const setParams = useEdfParams((state) => state.setParams)

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm text-fg-2">
      <span className="flex items-center gap-1.5">
        Слой
        <SelectField
          layout="inline"
          label="Слой сигнала"
          value={layer}
          options={SIGNAL_LAYER_OPTIONS}
          onChange={(value) => setParams({ signalLayer: value })}
        />
      </span>
      {layer === 'band' ? (
        <span className="flex items-center gap-1.5">
          Полоса
          <SelectField
            layout="inline"
            label="Полоса слоя"
            value={bandKey}
            options={bandOptions}
            onChange={(value) => setParams({ signalBandKey: value })}
          />
        </span>
      ) : null}
    </div>
  )
}
