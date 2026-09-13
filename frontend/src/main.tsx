import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { applyUiPreferences, useUiStore } from '@/shared/state/uiStore'
import './styles/index.css'

// UI-настройки применяем до первого рендера (data-атрибуты на <html>)
const { fontScale, density } = useUiStore.getState()
applyUiPreferences(fontScale, density)

const container = document.getElementById('root')
if (!container) throw new Error('Не найден контейнер #root')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
