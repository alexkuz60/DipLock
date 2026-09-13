import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

// Бэкенд по умолчанию — локальный uvicorn на :8000
const BACKEND = process.env.VITE_BACKEND_URL ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Собранный UI раздаёт FastAPI из backend/app/static/ui по пути /ui/
  base: '/ui/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: fileURLToPath(new URL('../backend/app/static/ui', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Прокси на бэкенд: в dev UI работает same-origin и CORS не нужен
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/health': { target: BACKEND, changeOrigin: true },
      '/init-status': { target: BACKEND, changeOrigin: true },
      '/docs': { target: BACKEND, changeOrigin: true },
      '/openapi.json': { target: BACKEND, changeOrigin: true },
      '/static': { target: BACKEND, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
