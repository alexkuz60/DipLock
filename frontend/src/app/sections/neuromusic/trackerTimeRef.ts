/**
 * Общий ref таймкода трекера «Нейромузыки»: span рисует тулс-хедер
 * (`TrackerControls`), текст пишет `paint` трекера (`WaveTracker`, rAF-цикл,
 * без ре-рендеров хедера — `docs/rules/frontend-perf.md`). Объект живёт в
 * модуле, потому что хедер и трекер — разные корни (`NeuromusicToolActions` /
 * `NeuromusicSection`), prop'ом их не связать.
 */
import type { RefObject } from 'react'

export const trackerTimeRef: RefObject<HTMLSpanElement | null> = { current: null }