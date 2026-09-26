/**
 * Тултип на Radix: подсказки у иконок-кнопок, клавиатурный фокус и a11y из коробки.
 *
 * По умолчанию подсказка открывается **снизу под триггером** (правка владельца
 * 26.09.2026): подсказки кнопок в хедерах не перекрывают соседние кнопки и контент
 * справа/слева. Стороны с явным смыслом указывают в месте использования:
 * левый рейл — `side="right"`, статус сервера в строке состояния — `side="top"`.
 */
import * as RadixTooltip from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={300} skipDelayDuration={120}>
      {children}
    </RadixTooltip.Provider>
  )
}

export type TooltipProps = {
  /** Текст подсказки (включая горячую клавишу, если есть) */
  label: string
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
}

export function Tooltip({ label, children, side = 'bottom' }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={8}
          className="z-50 max-w-sm rounded-md border border-border bg-bg-3 px-3 py-1.5 text-sm text-fg-0 shadow-xl"
        >
          {label}
          <RadixTooltip.Arrow className="fill-bg-3" width={10} height={5} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}
