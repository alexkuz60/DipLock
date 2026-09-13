# DipLock frontend (Vite + React + TS)

Дев-сервер и сборка UI для бэкенда FastAPI.

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173 (проксирует /api на :8000)
npm run test       # Vitest (jsdom)
npm run typecheck  # tsc --noEmit
npm run lint       # ESLint
npm run build      # сборка в ../backend/app/static/ui (раздаётся FastAPI по /ui/)
```

Бэкенд должен быть запущен:

```bash
cd ../backend && venv/bin/uvicorn app.main:app --reload --port 8000
```

Адрес бэкенда для dev-прокси переопределяется переменной `VITE_BACKEND_URL`.

## Структура

```
src/
├── app/
│   ├── layout/      # каркас: рейл разделов, тулс-хедер, правый сайдбар, статусбар
│   └── sections/    # реестр разделов (metadata) + компоненты рабочих областей и панелей опций
├── shared/
│   ├── api/         # типы контракта API и HTTP-клиент
│   ├── state/       # zustand-сторы: uiStore (настройки UI) и edfParams (параметры раздела EDF)
│   └── ui/          # Tooltip, IconButton, Button, Panel, Placeholder, StateViews,
│                    # контролы: FieldRow, SegmentedControl, SelectField, NumberField,
│                    #           CheckboxRow, StatusPill
└── styles/          # токены тёмной темы (Tailwind v4 @theme) и базовые стили
```

## Правило обработки данных

UI **не запускает расчёт сам**. Правка параметра только складывает выбор в стор раздела
(`shared/state/edfParams.ts`), а расчёт идёт отдельной задачей строго по кнопке
(`markApplied()` фиксирует снимок параметров, для которого получен результат). Пока результат
не получен или параметры изменились, панель показывает это статусом в блоке «Запуск».

Планируемый функционал разделов — в `docs/ui.md` (корень репозитория).
