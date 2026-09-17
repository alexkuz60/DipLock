/**
 * Перетаскиваемый разделитель двух областей по горизонтали («ЭЭГ»).
 *
 * Разделитель **не считает раскладку сам**: доля верхней области живёт в
 * состоянии раздела (`eegParams.splitRatio`), а математика — в
 * `shared/lib/eegView.ts` (`clampSplitRatio`, `splitHeights`). Компонент лишь
 * переводит движение мыши в новую долю и сообщает её наверх: у него нет «своей»
 * высоты, иначе состояние и картинка разошлись бы после первого же ресайза.
 *
 * Доступность: разделитель — это `role="separator"` с `aria-orientation`,
 * стрелки вверх/вниз двигают его с клавиатуры (мышью его таскают, но раздел
 * обязан работать и без мыши).
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { EEG_SPLITTER_H, clampSplitRatio } from '@/shared/lib/eegView'
import { cx } from '@/shared/ui/cx'

export type SplitPaneProps = {
  /** Доля верхней области (0..1) */
  ratio: number
  onRatioChange: (ratio: number) => void
  /** Высота контейнера, px: нужна для зажима долей по минимальным высотам */
  containerHeight: number
  /** Подпись для скринридеров */
  label?: string
}

export function SplitPane({ ratio, onRatioChange, containerHeight, label = 'Разделитель областей' }: SplitPaneProps) {
  const [dragging, setDragging] = useState(false)
  const startRef = useRef({ y: 0, ratio })

  const move = useCallback(
    (clientY: number) => {
      const start = startRef.current
      if (containerHeight <= 0) return
      const next = start.ratio + (clientY - start.y) / containerHeight
      onRatioChange(clampSplitRatio(next, containerHeight))
    },
    [containerHeight, onRatioChange],
  )

  // Слушатели на окне: указатель может уйти за пределы разделителя (тонкий, 8 px)
  useEffect(() => {
    if (!dragging) return
    const onMove = (event: PointerEvent) => move(event.clientY)
    const onUp = () => setDragging(false)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [dragging, move])

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // Не-левая кнопка (или её отсутствие в окружении без PointerEvent) — не жест
    if (typeof event.button === 'number' && event.button !== 0) return
    event.preventDefault()
    startRef.current = { y: event.clientY, ratio }
    setDragging(true)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const step = event.key === 'ArrowUp' ? -0.02 : 0.02
    onRatioChange(clampSplitRatio(ratio + step, containerHeight))
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={label}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      data-testid="eeg-splitter"
      data-dragging={dragging ? 'true' : 'false'}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      style={{ height: EEG_SPLITTER_H }}
      className={cx(
        'group relative shrink-0 cursor-row-resize touch-none select-none',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
      )}
    >
      <span
        aria-hidden
        className={cx(
          'absolute top-1/2 right-8 left-8 h-1 -translate-y-1/2 rounded-full transition-colors',
          dragging ? 'bg-accent' : 'bg-border group-hover:bg-fg-2',
        )}
      />
    </div>
  )
}
