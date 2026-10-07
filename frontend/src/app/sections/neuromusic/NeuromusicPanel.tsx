/**
 * Правый сайдбар («Опции раздела») «Нейромузыки»: параметры рендера, секция
 * «Пространство» (real-time цепочка плеера, spatial-audio) и справка
 * о партитуре (docs/rules/neuromusic.md). Силуэт комнаты переехал в секцию
 * «Визуализация» рабочей области под плеером (07.10.2026).
 *
 * Контролы правят стор `shared/state/neuromusic.ts`; параметры рендера уходят
 * на сервер только с запуском — кнопкой-иконкой в тулс-хедере (правка ≠
 * расчёт). Параметры пространства и вовсе не создают запросов: они применяются
 * к живому Tone-графу плеера мгновенно.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import type { AudioRenderVariant } from '@/shared/api/types'
import {
  MAX_SPATIAL_WIDTH_PCT,
  OCTAVE_SHIFTS,
  type OctaveShift,
  useNeuromusic,
} from '@/shared/state/neuromusic'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { NumberField } from '@/shared/ui/NumberField'
import { Panel } from '@/shared/ui/Panel'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { SelectField } from '@/shared/ui/SelectField'
import { bandLabel } from './bandLabels'
import { ROW_LABELS } from './rowMeta'

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
  const variant = useNeuromusic((state) => state.variant)
  const busy = useNeuromusic((state) => state.busy)
  const status = useNeuromusic((state) => state.status)
  const renderId = useNeuromusic((state) => state.renderId)
  const setBoostDb = useNeuromusic((state) => state.setBoostDb)
  const setLoudness = useNeuromusic((state) => state.setLoudness)
  const setLoudnessPhon = useNeuromusic((state) => state.setLoudnessPhon)
  const setAutobase = useNeuromusic((state) => state.setAutobase)
  const setOctaveShift = useNeuromusic((state) => state.setOctaveShift)
  const setVariant = useNeuromusic((state) => state.setVariant)

  // 3D-bake (spatial-audio, п.3): печать текущей цепочки на бэкенде.
  const bakeId = useNeuromusic((state) => state.bakeId)
  const bakeStatus = useNeuromusic((state) => state.bakeStatus)
  const bakeBusy = useNeuromusic((state) => state.bakeBusy)
  const bakeError = useNeuromusic((state) => state.bakeError)
  const startBake = useNeuromusic((state) => state.startBake)

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

  // Геометрия сцены: играющий рендер (status) важнее выбранного варианта —
  // до рендера показываем то, что будет посчитано кнопкой (силуэт при этом
  // живёт в секции «Визуализация» рабочей области — перенос 07.10.2026).
  const sceneVariant: AudioRenderVariant =
    (status?.variant ?? variant) === 'montage' ? 'montage' : 'express'

  return (
    <>
      <Panel
        title="Параметры рендера"
        hint="Правка значения не запускает расчёт: на сервер параметры уходят при нажатии кнопки «Создать аудио» в шапке раздела."
      >
        <div className="flex flex-col gap-3">
          <SegmentedControl
            label="Вариант"
            value={variant}
            options={[
              {
                value: 'express',
                label: 'Экспресс',
                title: '7 треков по шинам L/C/R — быстрая черновая проба созвучия полос',
              },
              {
                value: 'montage',
                label: 'Монтаж',
                title: '4 ряда схемы × 7 полос = 28 стерео-источников: геометрия модулей для 3D и запекания',
              },
            ]}
            onChange={(value) => setVariant(value as AudioRenderVariant)}
            hint="Как считать партитуру: «Экспресс» — шины полушарий, «Монтаж» — 4 ряда для 3D-цепочки; считает кнопка"
            disabled={running}
          />
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
          hint={
            (status?.rows ?? []).length > 0
              ? 'Готовый рендер «Монтаж»: WAV-мастер, рядовые треки (ряд × полоса) и партитура'
              : 'Готовый рендер: WAV-мастер, соль-треки полос и партитура (справка — § «Партитура»)'
          }
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
            {(status?.variant === 'montage' && (status?.rows ?? []).length > 0) ? (
              // «Монтаж»: 4 ряда × полосы — группировка по модулям, в том же
              // порядке, что и в статусе рендера (rows).
              <div className="flex flex-col gap-3" data-testid="montage-files">
                {(status?.rows ?? []).map((row) => (
                  <div key={row} className="flex flex-col gap-1">
                    <p className="text-xs font-medium uppercase tracking-wide text-fg-2">
                      {ROW_LABELS[row] ?? row}
                    </p>
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {(status?.tracks ?? []).map((band) => (
                        <li key={band} className="flex items-center gap-3 px-3 py-2">
                          <span className="text-sm text-fg-1">{bandLabel(band)}</span>
                          <a
                            className="ml-auto text-xs text-accent underline-offset-2 hover:underline"
                            href={api.audioRowTrackUrl(renderId, row, band)}
                            download={`neuromusic-${renderId}-${row}-${band}.wav`}
                          >
                            Скачать .wav
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
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
            )}
          </div>
        </Panel>
      )}

      <Panel
        title="Пространство"
        hint="3D-плеер (Tone.js): параметры применяются на лету к играющему треку — без пересчёта рендера (spatial-audio); «Запечь» печатает ту же цепочку на сервере."
      >
        <div className="flex flex-col gap-3">
          {/* Силуэт комнаты переехал в секцию «Визуализация» рабочей
              области (под плеером) — правка 07.10.2026. */}
          <CheckboxRow
            label="3D-режим плеера"
            checked={spatialEnabled}
            onChange={setSpatialEnabled}
            hint="Вместо обычного плеера — сцена на дуге («Экспресс») или в 4 модулях рядов («Монтаж»), HRTF-панорамирование и общая свёрточная реверберация"
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
            hint={
              sceneVariant === 'montage'
                ? '100 — полные геометрии модулей (дуги и линия ушей), 0 — все ряды свёрнуты к центрам'
                : '100 — полная дуга ±60° (слева δ, справа γ-high), 0 — все треки перед слушателем'
            }
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
                : spatialIr.startsWith('brainroom')
                  ? 'Муляж черепа BrainRoom (2/3.5/5 м, пропорции 1.0 : 1.3) — рекомендуется для «Монтажа»'
                  : 'Импульсная характеристика помещения (сгенерирована pyroomacoustics, spatial-audio)'
            }
            disabled={!spatialEnabled || irCatalog.isPending}
          />

          {/* 3D-bake (spatial-audio, п.3): та же цепочка, но печать на
              бэкенде — детерминированный WAV вместо real-time браузера. */}
          {renderId && status?.status === 'succeeded' && (
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-bg-1 p-3">
              <p className="text-sm text-fg-1">3D-bake: запечь цепочку в WAV</p>
              <p className="text-xs text-fg-2">
                Сервер печатает детерминированный файл с текущими параметрами (HRTF заменён
                амплитудной панорамой — spatial-audio, п.3); результат кэшируется по параметрам.
              </p>
              <Button
                variant="secondary"
                onClick={() => void startBake()}
                disabled={bakeBusy}
                data-testid="bake-start"
              >
                {bakeBusy ? 'Запекаем…' : 'Запечь 3D (WAV)'}
              </Button>
              {bakeBusy && (
                <div className="flex flex-col gap-1">
                  <div
                    role="progressbar"
                    aria-label="Прогресс запекания"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round((bakeStatus?.pct ?? 0) * 100)}
                    className="h-1.5 w-full overflow-hidden rounded-full bg-bg-3"
                  >
                    <span
                      className="block h-full rounded-full bg-accent transition-[width]"
                      style={{ width: `${Math.round((bakeStatus?.pct ?? 0) * 100)}%` }}
                    />
                  </div>
                  <p className="text-xs text-fg-2">{bakeStatus?.stage ?? 'Запуск…'}</p>
                </div>
              )}
              {bakeStatus?.status === 'succeeded' && bakeId && (
                <a
                  className={LINK_BUTTON_CLASS}
                  href={api.audioBakeWavUrl(renderId, bakeId)}
                  download={`neuromusic-${renderId}-3d-bake.wav`}
                  data-testid="bake-download"
                >
                  Скачать запечённый WAV
                </a>
              )}
              {bakeStatus?.status === 'failed' && (
                <p role="alert" className="text-xs text-danger">
                  Запекание не удалось: {bakeStatus.error ?? 'причина неизвестна'}
                </p>
              )}
              {bakeError && (
                <p role="alert" className="text-xs text-danger">
                  {bakeError}
                </p>
              )}
            </div>
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
