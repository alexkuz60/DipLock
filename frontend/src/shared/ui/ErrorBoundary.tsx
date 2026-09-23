/**
 * Граница ошибок рендера (React ErrorBoundary): падение любого компонента
 * показывается понятным блоком с перезагрузкой, а не белым экраном.
 *
 * Без неё одно исключение в рендере (например, `ReferenceError` в `TrackStack`
 * из-за рассинхрона файлов) обнуляло всё приложение без единой подсказки
 * (ручная проверка, 23.09.2026). Ошибку дополнительно печатает React (своим
 * сообщением в консоли браузера) — дублировать стек здесь не нужно.
 */
import { Component, type ReactNode } from 'react'
import { ErrorBlock } from './StateViews'

type ErrorBoundaryProps = {
  children: ReactNode
  /** Заголовок блока ошибки (в тестах — свой маркер) */
  title?: string
}

type ErrorBoundaryState = {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="p-3">
        <ErrorBlock
          title={this.props.title ?? 'Ошибка отрисовки приложения'}
          message={`${error.message} — перезагрузите страницу; если ошибка повторяется, откройте консоль браузера (F12) и пришлите текст ошибки.`}
          onRetry={() => window.location.reload()}
          retryLabel="Перезагрузить"
        />
      </div>
    )
  }
}