# UI §3.1, §3.6, §3.7, §4–§7, §9 — каркас, стек, запуск, контракт, хоткеи

### 3.1 Главная
- Заставка: 🧠 + `DipLock` + подзаголовок «Анализ ЭЭГ и расчёт токовых диполей в 3D».
- Строка готовности: «все компоненты готовы» / «часть компонентов не готова» / «сервер недоступен».
- Быстрые действия: «Открыть EDF», «Состояние сервера».
- Футер: версия приложения, версия MNE, драйвер БД (из `/api/v1/meta`).

### 3.6 Настройки
Масштаб текста (16/18/20 px), плотность списков, сброс раскладки разделов; таблица параметров
расчёта и путей — **только чтение**: источник истины `backend/.env`, дублирование настроек в UI
привело бы к конфликту конфигураций.

### 3.7 Состояние сервера
Проверки `/init-status`: MNE, конфигурация, БД, fsaverage, transform, BEM; версии
(Python/MNE/numpy/scipy/SQLAlchemy/trimesh), пути (`subjects_dir`, `trans`, `upload_dir`,
`results_dir`, `cache_dir`), параметры расчёта и API, признак сборки UI. Кнопка «Проверить сейчас»
+ поллинг 5 с — **только при открытой вкладке** (react-query не опрашивает сервер в фоне).

## 4. Технологический стек

| Слой | Выбор | Почему |
|---|---|---|
| Сборка | Vite 6 + TypeScript (strict) | HMR, code-splitting по разделам, `base: '/ui/'` — один базис для dev и prod |
| UI | React 19 | 7 разделов с общим состоянием, таблицы, 3D, playback: на Vanilla это не масштабируется |
| Стили | Tailwind CSS v4 + токены темы | тёмная тема через `@theme`, отдельная CSS-система не нужна. Утилита `.scroll-y-always` (срез 2.9) даёт **неотключаемый** вертикальный скроллбар с нативным пропорциональным ползунком: в вьюере ползунок показывает долю окна в записи, в панели опций полоса не «дёргается» между разделами |
| Примитивы | Radix UI (`@radix-ui/react-tooltip`) | тултипы с корректным a11y и клавиатурным доступом |
| Иконки | lucide-react | единый стиль, tree-shaking |
| Состояние | zustand (+`persist`) | UI-настройки, раскрытие панелей, счётчик задач (localStorage) |
| Серверные данные | TanStack Query | кэш, ретраи, поллинг задач, отсутствие фонового опроса скрытой вкладки |
| ЭЭГ-треки (Фаза 2) | uPlot | canvas, ~40 КБ, десятки тысяч точек на трек, draw-хуки для зон артефактов |
| 3D (Фаза 3) | react-three-fiber + drei | 3 проекции, playback, подсветка BA |
| Таблицы (Фаза 4) | TanStack Table + Virtual | тысячи строк без просадок |
| Тесты | Vitest + Testing Library | симметрия с pytest; 484 теста UI в 42 файлах (Фаза 1 + срезы 2.0–2.11, 3.1–3.9, 4), 187 pytest |

Отклонено: Vanilla + Three.js без сборки (нет типов/состояния/таблиц), Streamlit/NiceGUI (не тянет
интерактивный 3D и playback), общие chart-библиотеки (Recharts/Chart.js) для ЭЭГ — SVG/DOM не держат
десятки тысяч точек на трек при 60 fps.

## 5. Структура frontend/

```
frontend/
├── index.html                  # HTML-шаблон Vite
├── vite.config.ts              # base '/ui/', proxy на :8000, outDir → backend/app/static/ui
├── vitest.setup.ts             # jest-dom, изоляция тестов, заглушки ResizeObserver и uPlot
├── eslint.config.js / .prettierrc.json
└── src/
    ├── main.tsx                # точка входа: UI-настройки применяются до рендера
    ├── App.tsx                 # провайдеры + маршруты из SECTION_ROUTES
    ├── styles/index.css        # токены тёмной темы, базовые стили, scrollbar
    ├── app/
    │   ├── layout/             # AppShell (actions/headerExtra), IconRail, ToolHeader, RightPanel, StatusBar
    │   └── sections/           # registry.ts (метаданные), routes.tsx (компоненты + действия шапки)
    │       ├── HomeSection.tsx / SettingsSection.tsx / ServerStatusSection.tsx
    │       ├── EdfSection.tsx / EdfPanel.tsx       # зона загрузки, треки, панель параметров
    │       ├── EdfToolActions.tsx / EdfRecalcButtons.tsx   # действия тулс-хедара, стадии, прогресс
    │       ├── SessionPassportDialog.tsx / EdfZoomSelect.tsx  # паспорт сессии (для БД), зум + листание окна
    │       ├── viewer/TrackStack.tsx               # uPlot-стек треков: зум, панорама, курсор, разворот трека
    │       ├── viewer/TrackLayers.tsx / ExportActions.tsx  # DOM-слои (зоны/эпохи), кнопки экспорта окна
    │       ├── dipoles/        # MriProjection.tsx (SVG-проекция: слои, сетка, клик), DipolesSection/Panel.tsx,
    │       │                   # DipolesToolActions/Drawer.tsx (кнопка расчёта, порог «КД», топокарты/FFT)
    │       ├── table/          # LocalizationTable.tsx (таблица точек результата), Section/Panel.tsx (срез 4)
    │       ├── eeg/            # EegSection.tsx (две половины, разделитель, курсор), EegTrackView.tsx (трек),
    │       │                   # SpectrogramCanvas.tsx (сетка дБ), EegTimeline.tsx (полоса времени),
    │       │                   # EegPanel/ToolActions/WindowControls/HelpDialog.tsx, eegCanvas.ts (рамка холста)
    │       ├── SplitPane.tsx   # перетаскиваемый разделитель областей (срез 5)
    │       └── Stubs.tsx       # Групповой анализ (каркас Фазы 1)
    ├── shared/
    │   ├── api/                # types.ts (контракт API), client.ts (fetch + ApiError), upload.ts (XHR + прогресс)
    │   ├── lib/                # viewerMath.ts (окно/зум/огибающая), signalFrame.ts (разбор контейнера сигналов),
    │   │                       # viewerLayers.ts (геометрия слоёв + фикстура), artifacts.ts (типы/цвета артефактов),
    │   │                       # exportWindow.ts (CSV/PNG окна), download.ts (доставка файла), demoSignal.ts,
    │   │                       # mriProjections.ts (геометрия проекций: MNI ↔ фигура, слои, фитинги), dipolePoints.ts
    │   │                       # (точки диполей, векторы моментов), spectrum.ts (топокарты, гистограмма, PSD),
    │   │                       # tableRows.ts (колонки и строки таблицы локализации, сортировка по эпохе),
    │   │                       # eegView.ts (геометрия половин, линейки значений, разделитель),
    │   │                       # eegSpectrogram.ts (разбор сетки STFT, палитры, сглаживание, окно дБ),
    │   │                       # theme.ts (токены темы для canvas/DOM)
    │   ├── state/              # uiStore.ts, edfParams.ts (параметры + стадии), edfRecording.ts (запись, кадры сигналов, паспорт),
    │   │                       # dipoleParams.ts (слои проекций, срезы MNI, референс-точка),
    │   │                       # dipoleCalc.ts (расчёт и спектр, порог «КД»), tableParams.ts (сортировка/колонки таблицы),
    │   │                       # eegParams.ts (канал, окно, параметры спектрограммы, задача расчёта)
    │   └── ui/                 # Tooltip, IconButton, Button, Panel, Placeholder, StateViews, контролы (в т.ч.
    │                           # SliceScrubber — линейка среза MNI, ZoomNavControls — зум + листание окна)
    └── test/                   # fixtures, apiMocks, signalBlob/spectrogramBlob (энкодеры контейнеров), renderWithProviders, uplot
```

## 6. Запуск

```bash
# 1) Бэкенд
cd backend && venv/bin/uvicorn app.main:app --reload --port 8000

# 2) UI в режиме разработки (прокси на :8000, CORS не нужен)
cd frontend && npm install && npm run dev      # → http://localhost:5173/ui/

# 3) Прод-режим: собрать и раздавать из FastAPI
cd frontend && npm run build                   # → backend/app/static/ui
# → http://localhost:8000/ui/   (корень / редиректит на /ui/, старая страница осталась на /legacy)
```

Проверки качества: `npm run typecheck` (tsc strict), `npm run lint` (ESLint 9 flat config),
`npm run test` (Vitest, jsdom).

## 7. Контракт API ↔ UI

Источник истины — Pydantic-схемы `backend/app/schemas/analysis.py`, они попадают в OpenAPI
(`/openapi.json` содержит `AnalyzeResponse`, `DipoleFit`, `JobStatus`, `MetaResponse`, `SurfaceOut`…).
TS-типы в `frontend/src/shared/api/types.ts` пока описаны вручную; следующий шаг — генерация
через `openapi-typescript` (пункт дорожной карты). Каждый ответ типизирован: `response_model`
в FastAPI валидирует данные, поэтому расхождение контракта и реализации падает тестом, а не UI.

| Метод | Назначение | Кто использует |
|---|---|---|
| `POST /api/v1/jobs` | Запуск анализа: 202 + `job_id` | Диполи (Фаза 3), предподготовка EDF (Фаза 2) |
| `GET /api/v1/jobs/{id}` | Этап, прогресс 0..1, ошибка | прогресс-бар, индикатор задач в рейле |
| `GET /api/v1/jobs/{id}/result` | Результат по схеме `AnalyzeResponse` | 3 проекции, таблица локализации |
| `GET /api/v1/jobs` | История задач | «Состояние сервера» |
| `POST /api/v1/analyze` | Синхронный анализ (скрипты/curl) | не UI |
| `GET /api/v1/surface` | Меш fsaverage: ETag, `Cache-Control`, gzip | 3 проекции |
| `GET /api/v1/surface/brodmann` | Индексы вершин всех BA (≈1.8 МБ, кэш на неделю) | интерактивная карта BA |
| `GET /api/v1/surface/brodmann/{ba}` | Одна область (лёгкий ответ) | подсветка ROI |
| `GET /api/v1/brodmann-labels` | Имена меток из кэша | список BA в панели опций |
| `GET /api/v1/meta` | Версии, пути, параметры, `surface_version` | «Настройки», «Состояние сервера», provenance |
| `POST /api/v1/recordings` | Загрузка записи без обработки: 201 + паспорт записи; 200 + `deduplicated=true`, если файл с тем же sha256 уже хранится (копия не создаётся) | зона загрузки EDF (срез 2.2) |
| `GET /api/v1/recordings/{id}` | Паспорт записи по id (404 после TTL/вытеснения) | паспорт приходит в ответе загрузки; после среза 2.9 UI отдельным запросом его не перечитывает (метод клиента `api.recording` оставлен для будущих экранов) |
| `GET /api/v1/recordings/{id}/signals?level=` | Огибающая сигналов уровня ×1…×16: float32-контейнер `DPS1`, ETag/304 | вьюер треков (срез 2.5), раздел «ЭЭГ» (срез 5) |
| `POST /api/v1/recordings/{id}/spectrogram` | Запуск расчёта спектрограммы канала (STFT): 202 + `job_id` | раздел «ЭЭГ» по кнопке (срез 5) |
| `GET /api/v1/recordings/{id}/spectrogram/{job}` | Метаданные сетки (`SpectrogramResult`): оси, шкала дБ, `grid_url` | раздел «ЭЭГ» |
| `GET /api/v1/recordings/{id}/spectrogram/{job}/grid.bin` | Сетка уровней: float32-контейнер `DPS2` (частото-мажорно), ETag/304 | canvas спектрограммы |
| `GET /init-status` | Готовность + `versions` / `paths` / `ui` | «Состояние сервера», Главная |

**Измеренный эффект Фазы 0.** Payload `/analyze` уменьшился на ≈2 МБ (меш больше не вкладывается,
вместо него ссылка `surface: {version, url, brodmann_url}`); `/api/v1/surface` = 0.73 МБ против 2.86 МБ
общего JSON, BA-индексы (1.78 МБ, 82 области) вынесены в отдельный эндпоинт; меш строится один раз и
кэшируется на диске (`data/cache/surface/`), повторная отдача — `0.001 с` вместо ≈1.6 с пересчёта;
повторный запрос с `If-None-Match` получает 304. Также `n_epochs_total` теперь показывает все
нарезанные эпохи, а `n_epochs_dropped` — сколько отбросил reject-фильтр (раньше оба числа совпадали).

## 9. Состояния, хоткеи, доступность

Каждый раздел обязан уметь: **empty** (что сделать, чтобы появились данные), **loading** (скелет),
**error** (текст от FastAPI через `apiErrorText`, кнопка «Повторить»), **stale** («данные устарели,
пересчитать»). Примитивы: `Placeholder`, `LoadingBlock`, `ErrorBlock`, `InfoRow`.

Хоткеи: `1…6` — разделы (`3` — «ЭЭГ», срез 5), `[` — панель опций, `Space` — воспроизведение кадра
траектории (раздел «Диполи», срез 3.7); в следующих фазах добавятся `F` (вся сессия) и `+/-` (зум).
Обработчик игнорирует ввод в `INPUT/TEXTAREA/SELECT` и `contenteditable`, а хоткеи разделов не
перехватываются в чужих разделах (в «ЭЭГ» `Space` не занят — там обычная прокрутка).

Доступность: у иконочных кнопок есть `aria-label` и тултип; активный раздел помечен `NavLink`;
панель опций имеет `aria-label`; статусы проверок сервера подписаны текстом, а не только цветом;
фокус всегда виден (`:focus-visible` — акцентная обводка).

> Часть спецификации UI (прежний `docs/ui.md` §3.1, §3.6, §3.7, §4, §5, §6, §7, §9). Индекс и правила ведения — `docs/ui.md`.
> Номера разделов (§) сохранены: на них ссылаются код и тесты.
