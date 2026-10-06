/**
 * Правый сайдбар («Опции раздела») «Нейромузыки»: параметры рендера и справка
 * о партитуре (docs/rules/neuromusic.md).
 *
 * Контролы правят стор `shared/state/neuromusic.ts`; значения уходят на сервер
 * только с запуском — кнопкой-иконкой в тулс-хедере (правка ≠ расчёт).
 */
import { OCTAVE_SHIFTS, type OctaveShift, useNeuromusic } from '@/shared/state/neuromusic'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { NumberField } from '@/shared/ui/NumberField'
import { Panel } from '@/shared/ui/Panel'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'

export function NeuromusicPanel() {
  const boostDb = useNeuromusic((state) => state.boostDb)
  const loudness = useNeuromusic((state) => state.loudness)
  const loudnessPhon = useNeuromusic((state) => state.loudnessPhon)
  const autobase = useNeuromusic((state) => state.autobase)
  const octaveShift = useNeuromusic((state) => state.octaveShift)
  const busy = useNeuromusic((state) => state.busy)
  const status = useNeuromusic((state) => state.status)
  const setBoostDb = useNeuromusic((state) => state.setBoostDb)
  const setLoudness = useNeuromusic((state) => state.setLoudness)
  const setLoudnessPhon = useNeuromusic((state) => state.setLoudnessPhon)
  const setAutobase = useNeuromusic((state) => state.setAutobase)
  const setOctaveShift = useNeuromusic((state) => state.setOctaveShift)

  // На время рендера контролы гаснут — параметры уже ушли в POST
  const running = busy || status?.status === 'running'

  return (
    <>
      <Panel
        title="Параметры рендера"
        hint="Правка значения не запускает расчёт: на сервер параметры уходят при нажатии кнопки «Создать аудио» в шапке раздела."
      >
        <div className="flex flex-col gap-3">
          <SegmentedControl
            label="Транспонирование"
            value={String(octaveShift)}
            options={OCTAVE_SHIFTS.map((octaves) => ({
              value: String(octaves),
              label: `${octaves} октав`,
              title: `Подъём полос ×${2 ** octaves}: ${octaves === 5 ? 'басы глубже, слышимая «яма» — в верхних полосах (β/γ)' : octaves === 6 ? 'промежуточное звучание, «яма» — α/β/γ' : 'текущее звучание: δ в басах, «яма» — θ/α/β'}`,
            }))}
            onChange={(value) => setOctaveShift(Number(value) as OctaveShift)}
            hint="Октавы подъёма партитуры: ×32/×64/×128; считает кнопка"
          />
          <NumberField
            label="Усиление полос"
            unit="дБ"
            value={boostDb}
            onChange={setBoostDb}
            min={0}
            max={12}
            step={1}
            hint="Целевой уровень −18 дБ + усиление (0…12); считает кнопка"
            disabled={running}
          />
          <CheckboxRow
            label="Перцептуальный баланс (ISO 226)"
            checked={loudness}
            onChange={setLoudness}
            hint="Равная субъективная громкость полос: середина опускается, басы поднимаются"
            disabled={running}
          />
          {loudness && (
            <NumberField
              label="Уровень прослушивания"
              unit="фон"
              value={loudnessPhon}
              onChange={setLoudnessPhon}
              min={60}
              max={90}
              step={5}
              hint="Опорный уровень кривых равной громкости (60…90)"
              disabled={running}
            />
          )}
          {loudness && (
            <SegmentedControl
              label="Режим базы"
              value={autobase ? 'balance' : 'max'}
              options={[
                {
                  value: 'balance',
                  label: 'Баланс (≈ −17)',
                  title: 'Автобаза: середина θ/α/β выравнивается по ISO 226, boost — до запаса потолка',
                },
                {
                  value: 'max',
                  label: 'Максимум (boost)',
                  title: 'База −18+boost: треки громче, но crest-limited — компенсация почти не работает',
                },
              ]}
              onChange={(value) => setAutobase(value === 'balance')}
              hint="Без компрессии середину можно выровнять только опусканием — «баланс» и есть этот режим"
            />
          )}
        </div>
      </Panel>

      <Panel
        title="Партитура"
        hint="Как устроен рендер (эксперимент, docs/rules/neuromusic.md)"
      >
        <ul className="space-y-2 text-sm text-fg-2">
          <li className="ui-list-row py-1">
            7 полос мозговых волн = 7 инструментов: каждая полоса поднимается на 7 октав (×128) и
            звучит отдельным треком.
          </li>
          <li className="ui-list-row py-1">
            Сцена L/C/R по карте монтажа: левые и правые электроды — по краям стерео, срединные
            (Fz/Cz/Pz/Oz) — по центру в оба канала.
          </li>
          <li className="ui-list-row py-1">
            Вход: дефолтная очистка (гармоники notch, интерполяция мёртвых, ICA) и авто-notch 50 Гц —
            против свиста 6.4 кГц в партитуре.
          </li>
          <li className="ui-list-row py-1">
            Треки нормированы к −18 dBFS (все инструменты слышны), мастер — сумма с контролем пика
            −1 dBFS.
          </li>
          <li className="ui-list-row py-1">
            Партитура (.json) фиксирует веса, гейны и отпечаток входа — задел под будущие
            3D-панорамирование, реверберацию и дипольные траектории.
          </li>
        </ul>
      </Panel>
    </>
  )
}
