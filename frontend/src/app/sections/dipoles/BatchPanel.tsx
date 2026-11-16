/**
 * Панель «Пакет поддиапазонов» (С1/С2): полосы прогона и их отображение.
 *
 * Таблицы «Сопоставление полос» и «Кластеры диполей (С2)» — в разделе
 * «Таблица локализации» (вкладки просмотра, 16.11.2026): в сайдбаре их
 * приходилось прокручивать. Здесь остаётся форма «Черновик правила из
 * профиля» (Т5) — она делает запросы, а раздел таблицы ничего не запрашивает.
 *
 * Прогон всегда идёт по **всему каталогу** полос (`freq_bands` +
 * `functional_bands`) кнопкой «Рассчитать пакет» в шапке — выбор полос для
 * прогона из UI убран (его дублировал список отображения). Правка выбора
 * полос анимации/облака **ничего не запускает** (правило раздела). Результат —
 * набор (`batch`), а не один `result`: активная полоса выбирается в разделе
 * «Таблица локализации» (её точки показывают таблица и подписи), а здесь —
 * чекбоксы отображения. В сопоставлении — только **нормированные** величины:
 * GOF между полосами не сравним (принцип 3, `docs/rules/dipoles.md`), и колонки
 * GOF в его таблице нет.
 */
import { bandColor } from '@/shared/lib/bandColors'
import { calcJobSummary } from '@/shared/lib/dipoleCalcModel'
import { useDipoleCalc } from '@/shared/state/dipoleCalc'
import { Button } from '@/shared/ui/Button'
import { CheckboxRow } from '@/shared/ui/CheckboxRow'
import { Panel } from '@/shared/ui/Panel'
import { RuleDraftForm } from './RuleDraftForm'

export function BatchPanel() {
  const batch = useDipoleCalc((state) => state.batch)
  const batchJob = useDipoleCalc((state) => state.batchJob)
  const batchError = useDipoleCalc((state) => state.batchError)
  const activeBandKey = useDipoleCalc((state) => state.activeBandKey)
  const playbackBandKeys = useDipoleCalc((state) => state.playbackBandKeys)
  const togglePlaybackBand = useDipoleCalc((state) => state.togglePlaybackBand)
  const setPlaybackBandKeys = useDipoleCalc((state) => state.setPlaybackBandKeys)

  const bands = batch?.bands ?? []
  const comparison = batch?.comparison ?? []
  const clusters = batch?.clusters ?? []

  return (
    <Panel
      title="Пакет поддиапазонов"
      hint="С1: несколько расчётов одной сессии (узкие поддиапазоны δ/θ/α…) одним прогоном и их сопоставление. Ядро перебора строится один раз на пакет."
    >
      <p className="text-sm text-fg-2">
        Прогон идёт по всем полосам каталога кнопкой «Рассчитать пакет» в шапке
        раздела; здесь — полосы результата и их отображение (правка ничего не
        запускает).
      </p>
      {batchJob ? <p className="mt-2 text-sm text-fg-2">{calcJobSummary(batchJob)}</p> : null}
      {batchError ? <p className="mt-2 text-sm text-warn">{batchError}</p> : null}

      {bands.length > 0 ? (
        <>
          {/* П.1.4 (17.10.2026): любая комбинация полос в анимации и облаке —
              от всех до одной. Цвета полос — гамма от красного (δ) до
              ярко-фиолетового (высокая гамма), маркеры чекбоксов показывают её */}
          <p className="mt-3 text-sm font-medium">Полосы в анимации и облаке</p>
          <p className="mt-1 text-xs text-fg-2">
            Отмеченные полосы рисуются одновременно своими цветами (красный — δ,
            ярко-фиолетовый — высокая гамма): чекбоксы управляют и кадром анимации, и
            облаком точек с векторами.
          </p>
          {bands.map((band) => (
            <CheckboxRow
              key={`playback-${band.band_key}`}
              label={band.label}
              mono
              swatch={bandColor(band.band_hz)}
              hint={`Полоса ${band.band_hz[0]}–${band.band_hz[1]} Гц — в анимации и облаке точек`}
              checked={playbackBandKeys.includes(band.band_key)}
              onChange={() => togglePlaybackBand(band.band_key)}
            />
          ))}
          <div className="mt-2 flex gap-2">
            <Button
              onClick={() => setPlaybackBandKeys(bands.map((band) => band.band_key))}
              title="Показать в анимации и облаке все полосы пакета"
            >
              Все полосы
            </Button>
            <Button
              onClick={() => setPlaybackBandKeys(activeBandKey ? [activeBandKey] : [])}
              title="Показать только активную полосу (она выбрана в разделе «Таблица локализации»)"
            >
              Только активная
            </Button>
          </div>
        </>
      ) : null}

      {comparison.length > 0 || clusters.length > 0 ? (
        <p className="mt-3 text-xs text-fg-2">
          Сопоставление полос и кластеры диполей — в разделе «Таблица
          локализации» (вкладки просмотра).
        </p>
      ) : null}

      {clusters.length > 0 ? <RuleDraftForm bandKey={activeBandKey} /> : null}
    </Panel>
  )
}