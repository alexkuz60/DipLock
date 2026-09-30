import { createContext, useContext } from 'react'

/**
 * Слот действий в заголовке секции правой панели: содержимое поднимает свои
 * кнопки в подзаголовок через portal (кнопки экспорта окна вьюера — правка
 * 29.09.2026). `null` — слот ещё не смонтирован или секции нет (вьюер вне
 * панели, демо-режим) — тогда кнопки остаются в потоке содержимого.
 */
export const PanelActionsHostContext = createContext<HTMLElement | null>(null)

/** DOM-узел слота действий в заголовке секции (`null` — вне секции панели). */
export function usePanelActionsHost(): HTMLElement | null {
  return useContext(PanelActionsHostContext)
}
