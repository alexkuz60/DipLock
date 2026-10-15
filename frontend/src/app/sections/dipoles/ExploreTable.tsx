/**
 * Разведочный спектральный проход (С3): таблица отдельных частот — вход для
 * выбора узких поддиапазонов «Пакета поддиапазонов» (С1).
 *
 * Показывает **измерения**, а не «вывод из чисел» (правило
 * `docs/rules/dipoles.md`): полосы выбирает исследователь, таблица лишь
 * нормирует частоты между собой — доли от «полки» (максимум мощности полосы по
 * эпохам) и пика плотности **своей** полосы (базис С0), поэтому δ и γ впервые
 * сравнимы. Амплитудный диапазон частоты — разброс её мощности по эпохам
 * (минимум, медиана, максимум), тоже в долях от «полки» своей полосы.
 *
 * Числа приходят готовыми (`SpectrumResult.explore`), клиент ничего не
 * пересчитывает; сортировка — **параметр просмотра**: её правка не делает ни
 * одного запроса (как окно частот FFT-гистограммы).
 */
import { useState } from 'react'
import type { SpectrumExploreOut } from '@/shared/api/types'
import {
  bandLabel,
  formatShare,
  sortedExploreLines,
  type ExploreOrder,
} from '@/shared/lib/spectrum'
import { SegmentedControl } from '@/shared/ui/SegmentedControl'
import { cx } from '@/shared/ui/cx'

export type ExploreTableProps = {
  explore: SpectrumExploreOut
  className?: string
}

export function ExploreTable({ explore, className }: ExploreTableProps) {
  const [order, setOrder] = useState<ExploreOrder>('freq')
  const lines = sortedExploreLines(explore.lines ?? [], order)

  if (lines.length === 0) {
    return (
      <p className="text-sm text-fg-2" data-testid="explore-empty">
        Частоты не измерены: расчёт спектра не дал частотной сетки.
      </p>
    )
  }

  return (
    <div className={cx('flex flex-col gap-2', className)} data-testid="explore-table">
      <SegmentedControl
        label="Порядок"
        layout="inline"
        value={order}
        options={[
          {
            value: 'freq',
            label: 'по частоте',
            title: 'Строки — по возрастанию частоты (сетка PSD)',
          },
          {
            value: 'power',
            label: 'по мощности',
            title: 'Сильные частоты сверху: доля мощности бина от «полки» своей полосы',
          },
        ]}
        onChange={setOrder}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-fg-2">
              <th className="px-2 py-1">Частота, Гц</th>
              <th className="px-2 py-1">Ритм</th>
              <th className="px-2 py-1">Плотность, доля</th>
              <th className="px-2 py-1">Мощность, доля</th>
              <th className="px-2 py-1">Ампл. мин</th>
              <th className="px-2 py-1">Ампл. медиана</th>
              <th className="px-2 py-1">Ампл. макс</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr
                key={line.freq_hz}
                className="border-t border-border text-fg-1"
                data-testid="explore-row"
                data-freq={line.freq_hz}
              >
                <td className="tnum px-2 py-1">{line.freq_hz.toFixed(2)}</td>
                <td className="px-2 py-1">{bandLabel(line.band_key ?? '')}</td>
                <td className="tnum px-2 py-1" data-testid="explore-psd-share">
                  {formatShare(line.psd_share)}
                </td>
                <td className="tnum px-2 py-1" data-testid="explore-power-share">
                  {formatShare(line.power_share)}
                </td>
                <td className="tnum px-2 py-1">{formatShare(line.amp_min_share)}</td>
                <td className="tnum px-2 py-1">{formatShare(line.amp_median_share)}</td>
                <td className="tnum px-2 py-1">{formatShare(line.amp_max_share)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p
        className="text-sm text-fg-2"
        data-testid="explore-legend"
        title={`power_basis=${explore.power_basis}; psd_basis=${explore.psd_basis}`}
      >
        Доли нормированы по своей полосе: плотность — от пика PSD полосы, мощность и амплитуды —
        от «полки» (максимум мощности полосы по эпохам). Амплитудный диапазон — разброс мощности
        частоты по эпохам. Это вход для выбора полос пакета: выбор остаётся за исследователем.
      </p>
    </div>
  )
}