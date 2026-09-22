/**
 * Область секций правой панели: раздел, к которому относится `Panel`.
 *
 * Нужна, чтобы свёрнутость секций-аккордеонов хранилась **по разделам**
 * (`collapsedPanels` в `uiStore`, ключ «раздел:заголовок») и одинаковые заголовки
 * в «EDF» и «ЭЭГ» не делили одно состояние. Вне панели опций контекст пустой —
 * секции рабочей области («Настройки», «Состояние сервера») рисуются как обычно.
 */
import { createContext, useContext } from 'react'

export const PanelScopeContext = createContext<string | null>(null)

/** Идентификатор раздела для секций панели опций (`null` — вне панели). */
export function usePanelScope(): string | null {
  return useContext(PanelScopeContext)
}
