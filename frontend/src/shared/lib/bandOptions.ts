/**
 * Пункты селекта полосы слоя «По полосе» (Фаза B): ключи `freq_bands`/
 * `functional_bands` из `/meta` с подписями и границами.
 *
 * Ключ стабилен = адрес персиста подготовленного массива, поэтому в `value`
 * уходит именно он, а не границы; отсутствующие в метаданных ключи пункта не
 * имеют (как в списках пресетов фильтра). Функциональные ритмы — отдельным
 * `<optgroup>` (`FUNCTIONAL_GROUP`), как и в остальных селектах полос.
 *
 * Один хелпер на два места (правка 30.09.2026): секция «Отображение» панели
 * опций и комбо «Полоса» в подзаголовке секции «Треки записи» — списки
 * обязаны совпадать, иначе два селекта одного параметра разошлись бы.
 */
import type { MetaResponse } from '@/shared/api/types'
import { filterBandText, FUNCTIONAL_GROUP } from './calcFilter'
import { bandLabel } from './spectrum'

export type BandKeyOption = { value: string; label: string; group?: string }

export function bandKeyOptions(meta: MetaResponse | null | undefined): BandKeyOption[] {
  return [
    ...Object.entries(meta?.freq_bands ?? {}).map(([key, band]) => ({
      value: key,
      label: `${bandLabel(key)} ${filterBandText(band)}`,
    })),
    ...Object.entries(meta?.functional_bands ?? {}).map(([key, band]) => ({
      value: key,
      label: `${bandLabel(key)} ${filterBandText(band)}`,
      group: FUNCTIONAL_GROUP,
    })),
  ]
}
