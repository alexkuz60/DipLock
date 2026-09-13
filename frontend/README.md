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
│   ├── lib/         # чистая логика: viewerMath (окна/огибающая), signalFrame (контейнер DPS1),
│   │                # viewerLayers (слои: зоны артефактов, сетка эпох, фикстура), artifacts
│   │                # (типы/цвета артефактов), demoSignal
│   ├── state/       # zustand-сторы: uiStore (настройки UI), edfParams (параметры раздела EDF),
│                    # edfRecording (запись, сигналы вьюера, слои, задачи стадий предподготовки)
│   └── ui/          # Tooltip, IconButton, Button, Panel, Placeholder, StateViews,
│                    # контролы: FieldRow, SegmentedControl, SelectField, NumberField,
│                    #           CheckboxRow, StatusPill
└── styles/          # токены тёмной темы (Tailwind v4 @theme) и базовые стили
```

## Слои результата во вьюере

Слои — это результат предподготовки (зоны артефактов, границы эпох, штриховка отброшенных),
нарисованные **DOM поверх canvas-треков uPlot** (`app/sections/viewer/TrackLayers.tsx`). Так зона
остаётся кнопкой: клик даёт детали, а зум только пересчитывает позиции через `timeToX`, не трогая
canvas. Геометрия и фикстура — в `shared/lib/viewerLayers.ts` (чистые функции, покрыты тестами).

Пока стадии `artifacts`/`epochs` не подключены к серверу (срез 2.7), слои берутся из
детерминированной фикстуры `demoLayers` (`source: 'demo'`) — она одинакова между запусками, поэтому
тесты и сравнение «до/после» не шумят. Границы эпох считаются из параметра «длина эпохи», а не из
результата, — сетка живая уже сейчас. Цвета зон — токены темы (`--color-artifact-*`), заливка через
`color-mix`, hex в JS не дублируется.

## Правило обработки данных

UI **не запускает расчёт сам**. Правка параметра только складывает выбор в стор раздела
(`shared/state/edfParams.ts`), а расчёт идёт отдельной задачей строго по кнопке
(`markApplied()` фиксирует снимок параметров, для которого получен результат). Пока результат
не получен или параметры изменились, панель показывает это статусом в блоке «Запуск».

Кнопки стадий в тулс-хедере (`EdfRecalcButtons`) ставят задачу `POST /recordings/{id}/preprocess`
(`stage=filter|artifacts|epochs`), опрашивают прогресс через `GET /jobs/{id}` и кладут результат в
слои вьюера (`layers.source === 'result'`). Снимок параметров берётся в момент запуска
(`stageSignature` → `markStageApplied(stage, signature)`), поэтому правка параметра во время задачи
честно показывает «параметры изменены».

Планируемый функционал разделов — в `docs/ui.md` (корень репозитория).
