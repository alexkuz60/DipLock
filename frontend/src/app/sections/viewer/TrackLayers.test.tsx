/**
 * Тесты DOM-слоёв вьюера (срез 2.6): зоны артефактов, границы и штриховка эпох,
 * легенда и панель выделенной зоны.
 *
 * Проверяется то, что видно пользователю: отсечение зон по окну, клик по зоне,
 * тумблеры легенды, штриховка только отброшенных эпох. Арифметика слоёв —
 * в `shared/lib/viewerLayers.test.ts`, связка целиком — в `viewer/TrackStack.test.tsx`.
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import {
  ArtifactZoneLayer,
  EpochFrameLayer,
  EpochLayer,
  LayersLegend,
  SelectedZoneCard,
  type LayerGeometry,
} from './TrackLayers'
import { epochFramesForChannel } from '@/shared/lib/viewerLayers'
import type { ArtifactZone, EpochCell } from '@/shared/lib/viewerLayers'
import { renderWithProviders } from '@/test/renderWithProviders'

/** Окно 0–10 с на 100 px: timeToX(t) = t × 10 — числа в тестах считаются в уме. */
const GEOMETRY: LayerGeometry = { window: { t0: 0, t1: 10 }, trackWidth: 100 }

const ZONES: ArtifactZone[] = [
  { id: 'zscore_outlier-1', kind: 'zscore_outlier', onsetSec: 1, durationSec: 1, channels: ['F3'] },
  { id: 'flat_line-1', kind: 'flat_line', onsetSec: 2.5, durationSec: 0.5, channels: [] },
  { id: 'ica_eog-1', kind: 'ica_eog', onsetSec: 9.5, durationSec: 5, channels: ['F3', 'F4'] },
]

function cellsOf(patches: Partial<EpochCell>[] = []): EpochCell[] {
  return patches.map((patch, index) => ({
    index,
    onsetSec: index * 2,
    durationSec: 2,
    rejected: false,
    manual: null,
    rejectChannels: null,
    ...patch,
  }))
}

describe('слой зон артефактов', () => {
  it('рисует зоны в пикселях окна и подписывает их для тултипа', () => {
    renderWithProviders(
      <ArtifactZoneLayer zones={ZONES} geometry={GEOMETRY} selectedId={null} onSelect={() => {}} />,
    )

    const zone = screen.getByTestId('zone-zscore_outlier-1')
    expect(zone).toHaveStyle({ left: '10px', width: '10px' })
    expect(zone).toHaveAttribute('data-kind', 'zscore_outlier')
    expect(zone).toHaveAttribute('title', 'z-score выбросы: 1.000–2.000 с · каналы: F3')
    // Пустой список каналов означает «весь монтаж» — тултип обязан это сказать
    expect(screen.getByTestId('zone-flat_line-1')).toHaveAttribute(
      'title',
      expect.stringContaining('весь монтаж'),
    )
  })

  it('обрезает зону по правому краю окна и не рисует ушедшие за левый', () => {
    const outside: ArtifactZone = {
      id: 'peak_to_peak-1',
      kind: 'peak_to_peak',
      onsetSec: -3,
      durationSec: 2,
      channels: ['F3'],
    }
    renderWithProviders(
      <ArtifactZoneLayer
        zones={[...ZONES, outside]}
        geometry={GEOMETRY}
        selectedId={null}
        onSelect={() => {}}
      />,
    )

    // 9.5–14.5 с при окне до 10 с: правый край подрезан до 100 px
    const clipped = screen.getByTestId('zone-ica_eog-1')
    expect(clipped).toHaveStyle({ left: '95px', width: '5px' })
    expect(screen.queryByTestId('zone-peak_to_peak-1')).not.toBeInTheDocument()
  })

  it('клик по зоне выделяет её, повторный клик снимает выделение', async () => {
    const user = userEvent.setup()
    const onSelect = vi.fn()
    const { rerender } = renderWithProviders(
      <ArtifactZoneLayer
        zones={ZONES}
        geometry={GEOMETRY}
        selectedId={null}
        onSelect={onSelect}
      />,
    )

    await user.click(screen.getByTestId('zone-zscore_outlier-1'))
    expect(onSelect).toHaveBeenCalledWith('zscore_outlier-1')

    rerender(
      <ArtifactZoneLayer
        zones={ZONES}
        geometry={GEOMETRY}
        selectedId="zscore_outlier-1"
        onSelect={onSelect}
      />,
    )
    const selected = screen.getByTestId('zone-zscore_outlier-1')
    expect(selected).toHaveAttribute('aria-pressed', 'true')
    expect(selected).toHaveAttribute('data-selected', 'true')

    await user.click(selected)
    expect(onSelect).toHaveBeenLastCalledWith(null)
  })
})

describe('слой эпох', () => {
  it('штрихует только отброшенные эпохи', () => {
    renderWithProviders(
      <EpochLayer
        cells={cellsOf([{ rejected: true }, {}, { rejected: true }])}
        geometry={GEOMETRY}
        showBoundaries={false}
        showHatch
      />,
    )

    expect(screen.getByTestId('epoch-hatch-0')).toBeInTheDocument()
    expect(screen.queryByTestId('epoch-hatch-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('epoch-hatch-2')).toBeInTheDocument()
  })

  it('рисует границы без номеров и не рисует линию начала записи', () => {
    // Эпохи по 5 с на 100 px → 50 px на эпоху: широкие, но номера здесь всё равно
    // не рисуются — их несёт только липкая шкала (иначе дубль над верхним треком)
    const cells: EpochCell[] = [
      { index: 0, onsetSec: 0, durationSec: 5, rejected: false, manual: null, rejectChannels: null },
      { index: 1, onsetSec: 5, durationSec: 3, rejected: false, manual: null, rejectChannels: null },
      { index: 2, onsetSec: 8, durationSec: 2, rejected: false, manual: null, rejectChannels: null },
    ]
    renderWithProviders(
      <EpochLayer cells={cells} geometry={GEOMETRY} showBoundaries showHatch={false} />,
    )

    // Первая эпоха начинается в t0 (край записи) — линии нет; строки границ пустые
    expect(screen.queryByTestId('epoch-edge-0')).not.toBeInTheDocument()
    expect(screen.getByTestId('epoch-edge-1')).toBeEmptyDOMElement()
    expect(screen.getByTestId('epoch-edge-2')).toBeEmptyDOMElement()
  })

  it('рисует границы и при узких эпохах: линии от порога читаемости не зависят', () => {
    // 100 эпох по 0.1 с на 100 px → 1 px на эпоху: линии есть, номеров и тут нет
    const many = Array.from({ length: 100 }, (_, index) => ({
      index,
      onsetSec: index * 0.1,
      durationSec: 0.1,
      rejected: false,
      manual: null,
      rejectChannels: null,
    }))
    renderWithProviders(
      <EpochLayer cells={many} geometry={GEOMETRY} showBoundaries showHatch={false} />,
    )

    expect(screen.getByTestId('epoch-edge-1')).toBeEmptyDOMElement()
  })
})

describe('легенда слоёв', () => {
  const counts = { zscore_outlier: 3, peak_to_peak: 0, flat_line: 2, ica_eog: 1 }
  const visibility = { zscore_outlier: true, peak_to_peak: true, flat_line: false, ica_eog: true }

  it('показывает число зон по типам и состояние тумблера', () => {
    renderWithProviders(
      <LayersLegend counts={counts} visibility={visibility} onToggle={() => {}} />,
    )

    expect(screen.getByTestId('legend-zscore_outlier')).toHaveTextContent('z-score')
    expect(screen.getByTestId('legend-zscore_outlier')).toHaveTextContent('3')
    expect(screen.getByTestId('legend-zscore_outlier')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('legend-flat_line')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('group', { name: 'Легенда слоёв' })).toBeInTheDocument()
  })

  it('клик по пилюле открывает меню, «Вкл/Выкл слой» отдаёт тип наружу', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    renderWithProviders(
      <LayersLegend counts={counts} visibility={visibility} onToggle={onToggle} />,
    )

    await user.click(screen.getByTestId('legend-flat_line'))
    expect(screen.getByTestId('legend-menu-flat_line')).toBeInTheDocument()
    await user.click(screen.getByTestId('legend-menu-toggle-flat_line'))
    expect(onToggle).toHaveBeenCalledWith('flat_line')
    // Меню закрывается после действия — пилюля снова просто пилюля
    expect(screen.queryByTestId('legend-menu-flat_line')).not.toBeInTheDocument()
  })

  it('пилюля без зон тогглит слой сразу, без меню', async () => {
    const user = userEvent.setup()
    const onToggle = vi.fn()
    renderWithProviders(
      <LayersLegend counts={counts} visibility={visibility} onToggle={onToggle} />,
    )

    // У peak_to_peak ноль зон — меню не открывается, слой тумблерится кликом
    await user.click(screen.getByTestId('legend-peak_to_peak'))
    expect(onToggle).toHaveBeenCalledWith('peak_to_peak')
    expect(screen.queryByTestId('legend-menu-peak_to_peak')).not.toBeInTheDocument()
  })

  it('меню открывается над пилюлей и слоем выше липкой шкалы эпох', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <LayersLegend counts={counts} visibility={visibility} onToggle={() => {}} />,
    )

    await user.click(screen.getByTestId('legend-zscore_outlier'))
    const menu = screen.getByTestId('legend-menu-zscore_outlier')
    // Над пилюлей (`bottom-full`) и z-30 против z-20 у `EpochRuler`: при равных z
    // линейка эпох рисовалась поверх меню (фидбэк 24.09.2026)
    expect(menu.className).toContain('bottom-full')
    expect(menu.className).toContain('z-30')
  })

  it('меню несёт разделитель и тумблер режима «Навигация» (вкл/выкл, с галочкой)', async () => {
    const user = userEvent.setup()
    const onToggleNavMode = vi.fn()
    renderWithProviders(
      <LayersLegend
        counts={counts}
        visibility={visibility}
        onToggle={() => {}}
        navMode="window"
        onToggleNavMode={onToggleNavMode}
      />,
    )

    await user.click(screen.getByTestId('legend-zscore_outlier'))
    const menu = screen.getByTestId('legend-menu-zscore_outlier')
    expect(menu).toHaveTextContent('Вкл/Выкл слой')
    expect(menu).toHaveTextContent('Вкл/Выкл режима "Навигация"')
    expect(screen.getByRole('separator')).toBeInTheDocument()
    expect(screen.getByTestId('legend-menu-nav-zscore_outlier')).toHaveAttribute(
      'aria-checked',
      'false',
    )

    await user.click(screen.getByTestId('legend-menu-nav-zscore_outlier'))
    // Режим включается по артефактам кликнутой пилюли («по своим»)
    expect(onToggleNavMode).toHaveBeenCalledWith('zscore_outlier')
  })

  it('галочка «Навигация» — только у пилюли своего типа', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <LayersLegend
        counts={counts}
        visibility={visibility}
        onToggle={() => {}}
        navMode="artifact"
        navKind="zscore_outlier"
        onToggleNavMode={() => {}}
      />,
    )

    await user.click(screen.getByTestId('legend-zscore_outlier'))
    expect(screen.getByTestId('legend-menu-nav-zscore_outlier')).toHaveAttribute(
      'aria-checked',
      'true',
    )
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('legend-flat_line'))
    expect(screen.getByTestId('legend-menu-nav-flat_line')).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('без обработчика навигации пункт не показывается; Escape закрывает меню', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <LayersLegend counts={counts} visibility={visibility} onToggle={() => {}} />,
    )

    await user.click(screen.getByTestId('legend-zscore_outlier'))
    expect(screen.queryByTestId('legend-menu-nav-zscore_outlier')).not.toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('legend-menu-zscore_outlier')).not.toBeInTheDocument()
  })
})

describe('панель выделенной зоны', () => {
  it('показывает тип, интервал, длительность и каналы', () => {
    renderWithProviders(<SelectedZoneCard zone={ZONES[2]!} onClose={() => {}} />)

    const card = screen.getByTestId('zone-details')
    expect(card).toHaveTextContent('ICA')
    expect(card).toHaveTextContent('9.500–14.500 с')
    expect(card).toHaveTextContent('Каналы: F3, F4')
  })

  it('пустой список каналов читается как «весь монтаж», крестик закрывает панель', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderWithProviders(<SelectedZoneCard zone={ZONES[1]!} onClose={onClose} />)

    expect(screen.getByTestId('zone-details')).toHaveTextContent('Каналы: весь монтаж')

    await user.click(screen.getByRole('button', { name: 'Скрыть детали зоны' }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('рамки эпох-отбросов в треке канала-виновника', () => {
  it('рисует рамку своей эпохи, клики не перехватывает', () => {
    const cells = cellsOf([{ rejected: true, rejectChannels: ['F3'] }, {}])
    renderWithProviders(<EpochFrameLayer cells={cells} geometry={GEOMETRY} />)

    // Нумерация testid с 1 (как у ячеек шкалы эпох); рамка — декоративная обводка
    const frame = screen.getByTestId('epoch-frame-1')
    expect(frame).toHaveStyle({ left: '0px', width: '20px' })
    expect(frame.className).toContain('pointer-events-none')
  })

  it('не рисует рамки вне окна; эпоха без канала-виновника рамок не даёт', () => {
    const cells = cellsOf([
      { onsetSec: 20, durationSec: 2, rejected: true, rejectChannels: ['F3'] },
      { rejected: true, rejectChannels: [] },
    ])
    renderWithProviders(<EpochFrameLayer cells={epochFramesForChannel(cells, 'F3')} geometry={GEOMETRY} />)

    // Эпоха за правым кром окна обрезана, «без виновника» фильтром канала не прошла
    expect(screen.queryByTestId('epoch-frame-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('epoch-frame-2')).not.toBeInTheDocument()
  })
})
