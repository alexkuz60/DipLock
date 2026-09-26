/**
 * Реестр секций панели опций для меню быстрого перемещения в её хедере.
 *
 * Каждая секция-аккордеон (`Panel`) внутри панели опций регистрирует себя здесь
 * (ключ свёрнутости, заголовок и DOM-элемент), а `RightPanel` по этому реестру
 * строит меню: выбор пункта раскрывает секцию и прокручивает к ней сайдбар.
 * Вне панели опций (`PanelScopeContext` пуст) секция не регистрируется — меню
 * показывает только содержимое сайдбара.
 *
 * Порядок пунктов = порядок монтирования секций = порядок их следования в панели;
 * перемонтирование секции (например, после смены заголовка) перерегистрирует её
 * на прежнее место за счёт обновления по ключу.
 */
import { createContext, useContext } from 'react'

export type PanelNavItem = {
  /** Ключ свёрнутости секции («раздел:заголовок», `uiStore.collapsedPanels`) */
  key: string
  /** Заголовок секции — пункт меню */
  title: string
  /** DOM-элемент секции — цель прокрутки */
  el: HTMLElement
}

export type PanelNavRegistry = {
  /** Регистрирует секцию; возвращаемая функция снимает регистрацию */
  register: (item: PanelNavItem) => () => void
}

export const PanelNavContext = createContext<PanelNavRegistry | null>(null)

/** Реестр секций панели опций (`null` — вне панели, регистрировать некого). */
export function usePanelNavRegistry(): PanelNavRegistry | null {
  return useContext(PanelNavContext)
}