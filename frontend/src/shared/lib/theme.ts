/**
 * Цвета темы для canvas-отрисовки (вынесено из экспорта окна, срез 3.1).
 *
 * Canvas не умеет читать CSS-токены (`color-mix` тем более), поэтому цвета
 * разрешаются через `getComputedStyle` с hex-fallback из `styles/index.css`.
 * Реализация одна на всё приложение: и PNG-снапшот вьюера треков
 * (`shared/lib/exportWindow.ts`), и проекции мозга
 * (`app/sections/dipoles/MriProjection.tsx`) читают токены одинаково — hex-значения
 * темы не дублируются в JS, а источники цветов остаются токенами в CSS.
 *
 * Модуль чистый: DOM трогает только `themeColor`, и лишь тот документ, который
 * ему передали (поэтому он тестируется без браузера).
 */

/** Цвет темы внутри canvas: токен резолвим через `getComputedStyle` (hex-fallback). */
export function themeColor(doc: Document, token: string, fallback: string): string {
  const view = doc.defaultView
  if (!view) return fallback
  const value = view.getComputedStyle(doc.documentElement).getPropertyValue(token)
  return value.trim() || fallback
}

/** `#rrggbb` + alpha → `rgba(...)`: canvas не понимает `color-mix` из токенов. */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim().replace(/^#/, '')
  if (!/^[0-9a-f]{6}$/i.test(hex)) return color
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${Math.min(1, Math.max(0, alpha))})`
}
