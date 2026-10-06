/**
 * Правый сайдбар («Опции раздела») «Нейромузыки»: параметры рендера, секция
 * «Пространство» (real-time цепочка плеера, spatial-audio) и справка
 * о партитуре (docs/rules/neuromusic.md).
 *
 * Контролы правят стор `shared/state/neuromusic.ts`; параметры рендера уходят
 * на сервер только с запуском — кнопкой-иконкой в тулс-хедере (правка ≠
 * расчёт). Параметры пространства и вовсе не создают запросов: они применяются
 * к живому Tone-графу плеера мгновенно.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import {
  MAX_SPATIAL_WIDTH_PCT,
  OCTAVE_SHIFTS,
  type OctaveShift,
  useNeuromusic,
} from '@/shared/state/neuromusic'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { NumberField } from '@/shared/ui/NumberField'
import { Panel } from '@/shared/ui/Panel'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { SelectField } from '@/shared/ui/SelectField'
import { bandLabel } from './bandLabels'

/**
 * Стиль ссылок-кнопок («Скачать…»): тот же набор, что ``Button variant="secondary"`` —
 * для ``<a download>`` нужен именно тег ссылки, а не кнопка.
 */
const LINK_BUTTON_CLASS =
  'inline-flex items-center gap-2 rounded-lg border border-border bg-bg-2 px-4 py-2 ' +
  'text-base font-medium text-fg-0 transition-colors hover:bg-bg-3'

export function NeuromusicPanel() {
  const boostDb = useNeuromusic((state) => state.boostDb)
  const loudness = useNeuromusic((state) => state.loudness)
  const loudnessPhon = useNeuromusic((state) => state.loudnessPhon)
  const autobase = useNeuromusic((state) => state.autobase)
  const octaveShift = useNeuromusic((state) => state.octaveShift)
  const busy = useNeuromusic((state) => state.busy)
  const status = useNeuromusic((state) => state.status)
  const renderId = useNeuromusic((state) => state.renderId)
  const setBoostDb = useNeuromusic((state) => state.setBoostDb)
  const setLoudness = useNeuromusic((state) => state.setLoudness)
  const setLoudnessPhon = useNeuromusic((state) => state.setLoudnessPhon)
  const setAutobase = useNeuromusic((state) => state.setAutobase)
  const setOctaveShift = useNeuromusic((state) => state.setOctaveShift)

  // Пространственная обработка (real-time, без запросов при правке).
  const spatialEnabled = useNeuromusic((state) => state.spatialEnabled)
  const spatialWidthPct = useNeuromusic((state) => state.spatialWidthPct)
  const spatialSpreadPct = useNeuromusic((state) => state.spatialSpreadPct)
  const spatialWetPct = useNeuromusic((state) => state.spatialWetPct)
  const spatialIr = useNeuromusic((state) => state.spatialIr)
  const setSpatialEnabled = useNeuromusic((state) => state.setSpatialEnabled)
  const setSpatialWidthPct = useNeuromusic((state) => state.setSpatialWidthPct)
  const setSpatialSpreadPct = useNeuromusic((state) => state.setSpatialSpreadPct)
  const setSpatialWetPct = useNeuromusic((state) => state.setSpatialWetPct)
  const setSpatialIr = useNeuromusic((state) => state.setSpatialIr)

  // Каталог IR пресетов: один GET на сессию, только когда 3D-режим включён
  // (TanStack Query, кэш по ключу).
  const irCatalog = useQuery({
    queryKey: ['audio-ir-catalog'],
    queryFn: ({ signal }) => api.audioIrCatalog(signal),
    enabled: spatialEnabled,
    staleTime: Number.POSITIVE_INFINITY,
  })

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

      {renderId && status?.status === 'succeeded' && (
        <Panel
          title="Файлы"
          hint="Готовый рендер: WAV-мастер, соль-треки полос и партитура (справка — § «Партитура»)"
        >
          <div className="flex flex-col gap-2">
            <a
              className={LINK_BUTTON_CLASS}
              href={api.audioMasterUrl(renderId)}
              download={`neuromusic-${renderId}.wav`}
            >
              Скачать мастер
            </a>
            <a
              className={LINK_BUTTON_CLASS}
              href={api.audioSidecarUrl(renderId)}
              download={`neuromusic-${renderId}-sidecar.json`}
            >
              Скачать партитуру (.json)
            </a>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {(status?.tracks ?? []).map((band) => (
                <li key={band} className="flex items-center gap-3 px-3 py-2">
                  <span className="text-sm text-fg-1">{bandLabel(band)}</span>
                  <a
                    className="ml-auto text-xs text-accent underline-offset-2 hover:underline"
                    href={api.audioTrackUrl(renderId, band)}
                    download={`neuromusic-${renderId}-${band}.wav`}
                  >
                    Скачать .wav
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      )}

      <Panel
        title="Пространство"
        hint="3D-плеер (Tone.js): параметры применяются на лету к играющему треку — без пересчёта рендера (spatial-audio)."
      >
        <div className="flex flex-col gap-3">
          <CheckboxRow
            label="3D-режим плеера"
            checked={spatialEnabled}
            onChange={setSpatialEnabled}
            hint="Вместо обычного плеера — 7 треков на дуге, HRTF-панорамирование и свёрточный ревербератор"
          />
          <NumberField
            label="Ширина базы"
            unit="%"
            value={spatialWidthPct}
            onChange={setSpatialWidthPct}
            min={0}
            max={MAX_SPATIAL_WIDTH_PCT}
            step={10}
            hint="Mid/Side стерео: 100 — без изменения, меньше — к моно, больше — шире"
            disabled={!spatialEnabled}
          />
          <NumberField
            label="Разброс по дуге"
            unit="%"
            value={spatialSpreadPct}
            onChange={setSpatialSpreadPct}
            min={0}
            max={100}
            step={10}
            hint="100 — полная дуга ±60° (слева δ, справа γ-high), 0 — все треки перед слушателем"
            disabled={!spatialEnabled}
          />
          <NumberField
            label="Влажность реверберации"
            unit="%"
            value={spatialWetPct}
            onChange={setSpatialWetPct}
            min={0}
            max={100}
            step={5}
            hint="Доля IR в миксе: 0 — сухой сигнал, 100 — только реверберация"
            disabled={!spatialEnabled}
          />
          <SelectField
            label="Помещение (IR)"
            value={spatialIr}
            options={(irCatalog.data?.presets ?? []).map((preset) => ({
              value: preset.id,
              label: preset.label,
              title: preset.description,
            }))}
            onChange={setSpatialIr}
            hint={
              irCatalog.isError
                ? 'Каталог IR не загрузился — реверберация использует прежний пресет'
                : 'Импульсная характеристика помещения (сгенерирована pyroomacoustics, spatial-audio)'
            }
            disabled={!spatialEnabled || irCatalog.isPending}
          />
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
