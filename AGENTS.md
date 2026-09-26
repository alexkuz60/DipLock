# AGENTS.md — инструкции для ИИ-агентов (DipLock)

> Файл читается автоматически ИИ-агентами (Copilot, Cursor, Codex, Claude Code и др.).
> Обзор полной архитектуры: `audit.md`, `README.md`. Держите этот файл компактным.

## Обзор

FastAPI-бекенд + React/TS-фронтенд для анализа ЭЭГ: EDF → артефакты → эпохи → фильтры → диполи → 3D-локализация.
Стек: **Python 3.12, FastAPI, MNE-Python, SQLAlchemy (SQLite/dev, PostgreSQL/prod), Docker**;
UI — **Vite 6 + React 19 + TypeScript (strict) + Tailwind CSS v4 + TanStack Query + zustand**.
Научные данные FSAverage (FreeSurfer) лежат локально в `~/mne_data/`.

## Команды

```bash
# --- backend ---
cd backend && python -m venv venv
venv/bin/pip install -r requirements.txt              # + requirements-dev.txt для тестов, ruff, mypy
venv/bin/uvicorn app.main:app --reload --port 8000    # рабочая директория — backend/
venv/bin/python -m pytest                             # тесты backend
venv/bin/ruff check app tests scripts                 # линтер (конфиг: backend/pyproject.toml)
venv/bin/mypy app                                     # проверка типов

# проверка API (Swagger: http://localhost:8000/docs)
curl http://localhost:8000/health        # {"status":"ok",...}
curl http://localhost:8000/init-status   # готовность MNE/БД/fsaverage + версии/пути/UI
curl http://localhost:8000/api/v1/meta   # версии, параметры расчёта, surface_version
# спектрограмма канала («ЭЭГ»): задача → метаданные → сетка чисел (DPS2)
curl -X POST -F channel=Fp1 -F window_ms=500 http://localhost:8000/api/v1/recordings/<id>/spectrogram

# --- frontend ---
cd frontend && npm install
npm run dev        # http://localhost:5173/ui/ (proxy /api → :8000, CORS не нужен)
npm run test       # Vitest (jsdom)
npm run typecheck  # tsc --noEmit
npm run lint       # ESLint 9
npm run build      # → ../backend/app/static/ui (раздаётся FastAPI по /ui/)
npm run build:watch # автосборка туда же при правках: :8000/ui/ не отдаёт устаревший бандл
```

Детали фронтенда — `frontend/README.md`.


## Структура

```
backend/app/
├── main.py            # FastAPI entry: CORS (5173), gzip, раздача /ui (сборка frontend) и /legacy
├── core/config.py     # Pydantic-settings — ЕДИНЫЙ источник конфига
├── api/               # роуты + адаптеры HTTP (этап 3)
│   ├── routes.py      # 32 роута (инвентарь — `docs/rules/api-jobs.md`)
│   ├── assets.py      # ETag/304: единственный помощник отдачи ассетов (A2)
│   ├── params.py      # формы → параметры сервисов, 400 с текстом для UI (A1)
│   ├── recording_jobs.py # задачи записи: старт 202, статус, результат (A1)
│   └── uploads.py     # приём EDF: имя, размер, sha256 (F10)
├── schemas/           # Pydantic-контракт ответов (OpenAPI → TS-типы UI)
├── models/db.py       # SQLAlchemy модели (Session, Epoch, Dipole): пишется только legacy-анализ
├── utils/             # brain_export.py, versions.py, png.py (энкодер срезов),
│                      # marching_squares.py (изолинии маски без зависимостей)
├── services/          # КАЖДЫЙ модуль = один шаг пайплайна
│   ├── edf_loader.py  # read_raw_edf → pick/montage/reference/filter
│   ├── artifact_detector.py, artifact_cleaner.py, epoch_segmenter.py, bandpass_filter.py
│   ├── filter_design.py # дизайн фильтра: FIR/IIR, переходные полосы, буферы края, АЧХ (2.5)
│   ├── dipole_fitter.py     # точный фитинг (эксперим.): mne.fit_dipole по эпохам, цена в /meta
│   ├── recordings.py      # реестр записей просмотра: паспорт, TTL, дедуп (2.2)
│   ├── recording_signals.py # пирамида сигналов вьюера: огибающая ×1…×16, кэш (2.5)
│   ├── preprocess.py      # стадии предподготовки записи: filter/artifacts/epochs (2.7)
│   ├── spectral.py        # спектр δ…γ (Welch/multitaper + 1/f-фит specparam) + топокарты PNG, кэш + ETag (3.4)
│   ├── spectrogram.py     # спектрограмма канала: STFT → сетка дБ (DPS2), кэш + ETag (5)
│   ├── channel_mix.py     # виртуальные каналы «ЭЭГ»: миксы групп 10-20 из паспорта записи (5+)
│   ├── dipole_scanner.py  # быстрый расчёт: сетка узлов, сферическая модель (3.4)
│   ├── analysis_pipeline.py # пайплайн файлового анализа (/analyze, /jobs) + запись в БД (A1)
│   ├── cache_store.py     # единый дисковый кэш: путь/чтение/атомарная запись/очистка (этап 2)
│   ├── journal.py         # журнал шагов пайплайнов: GET /journal (этап 5)
│   ├── job_store.py       # файл задачи на диске: история и результат (A8)
│   ├── orphans.py         # обход сирот при старте (A6)
│   ├── asset_versions.py  # единый отпечаток версий ассетов (A7)
│   ├── prepared_signal.py # RAM-кэш подготовленного сигнала: EDF один раз на набор параметров (A4)
│   ├── job_manager.py     # фоновые задачи: этапы, прогресс эпох, семафор (F7)
│   ├── surface_cache.py   # кэш меша/BA на диске + ETag/304 (F6)
│   ├── mri_slices.py      # том T1 на MNI-сетке, срез картинкой (PNG) + ETag/304 (3.2)
│   └── atlas_contours.py  # контуры структур и полей Бродмана на срезе (вектор, ETag) (3.9)
backend/scripts/       # dedupe_recordings.py (чистка дублей в data/edf),
                       # build_atlas_contours.py (прогрев кэша контуров, 3.9)
backend/pyproject.toml # конфиг ruff + mypy
frontend/              # UI (Vite+React+TS), сборка → backend/app/static/ui
data/                  # локальные данные (edf/results/cache) — НЕ коммитить
docs/ui.md             # спецификация UI и дорожная карта фаз
.github/workflows/     # CI: ruff+mypy+pytest и lint+tsc+Vitest+build
```

## Конвенции

- **DRY**: частотные диапазоны (`freq_bands`) и длины эпох берите из `core/config.py`,
  не дублируйте в сервисах.
- **Не хардкодить пути** `/home/...` — только из `settings`/окружения.
- Типизация: все подписи функций — с аннотациями типов; докстринги на русском.
- **Async**: НЕ выполняйте тяжёлые MNE/CPU-операции напрямую в `async def` — используйте
  `asyncio.to_thread` / `run_in_executor` или job-очередь (`app/services/job_manager.py`).
- **Контракт API** описывается Pydantic-моделями в `app/schemas/` (+`response_model`): из OpenAPI
  генерируются TS-типы UI; «сырые» dict в ответах не добавляем.
- **Тяжёлые статические ассеты** (меш fsaverage, BA-индексы) — только отдельными кэшируемыми
  эндпоинтами (`app/services/surface_cache.py`), никогда внутри `/analyze`.
- **Роут = форма и контракт, работа — в слое ниже**: приём файла (`api/uploads.py`), разбор формы и
  400-тексты (`api/params.py`), задачи записи (`api/recording_jobs.py`), расчёты (`services/*`).
- **Ассеты — только через `app/api/assets.py`** (`asset_response`): ETag, `Cache-Control` и 304 в
  одном месте, ручных `status_code=304` в роутах нет — ловит `tests/test_api_assets.py` (A1/A2).
- Один шаг пайплайна = один модуль в `services/`, без смешивания ответственности.
- Кэшируйте ресурсоёмкие объекты (поверхности FSAverage, transform, labels).
- **Данные — только через свои сервисы:** кэши — `cache_store.py`, подготовленный сигнал —
  `prepared_signal.py`, версии ассетов — `asset_versions.py`, результат задачи — `job_store.py`,
  сироты — `orphans.py`; инварианты — `docs/rules/data-and-caches.md`.
- **Frontend**: новый раздел UI = запись в `frontend/src/app/sections/registry.ts` + компонент в
  `routes.tsx`; тексты — на русском; ожидание задач — общее (`shared/lib/jobPolling.ts`), адреса —
  парами (`recordingJob(kind)`); контролы — из `shared/ui/` (`FieldRow`, `SegmentedControl`,
  `SelectField`, `NumberField`, `CheckboxRow`, `StatusPill`).
- **Frontend-ловушки:** `className` ссылки рейла обязан быть строкой, а правка параметра **не**
  запускает расчёт (считает только кнопка) — `docs/rules/frontend-state.md`.
  **Правки UI видны на :8000/ui/ только после `npm run build`** — иначе раздаётся прошлый бандл и
  «правка не работает» при живом коде (случай 24.09.2026). Держите `npm run build:watch`
  (автосборка в `backend/app/static/ui`); на :5173/ui/ правки видны сразу (Vite dev).
  Vite dev может отдать **залипший трансформ-кэш промежуточной правки** (симптом: гибрид — часть
  новой логики есть, часть старого поведения; лечение — перезапуск `npm run dev`, случай 24.09.2026).
- **Бэкенд-ловушки:** правки backend видны в API только после перезагрузки процесса — держите
  uvicorn с `--reload`. Признак устаревшего процесса — `init-status.code.stale=true`
  («Состояние сервера» → «Код бэкенда»): перезапустите сервер и **«Пересчитайте» запись** —
  файлы задач и результаты стадий переживают перезагрузку и продолжают показывать старые числа
  (разъехавшиеся счётчики тултипа/пиуль и отказ нарезки эпох — случай 24.09.2026).

## НЕ коммитить

- `venv/`, `__pycache__/`, `.env`, `data/results/`, `*.db` — см. `.gitignore`.
- `.env` содержит локальные пути/настройки — вместо него есть `.env.example`.

## Карта документации

`AGENTS.md` — вход (≤15 КБ): обзор, команды, структура, конвенции. Правила живут по темам:

| Куда смотреть | Что там |
|---|---|
| `concept.md`, `docs/data-blocks.md` | зачем проект (миссия, критерии метода, способности) и кирпичики данных (структура до БД) |
| `docs/rules/edf-viewer.md` | вьюер треков: интерактив, разметка эпох, оверлеи |
| `docs/rules/events.md` | события записи и ERP: EDF+-аннотации/маркеры, нарезка по событиям, `kind=evoked` |
| `docs/rules/artifacts.md` | артефакты: каталог 11 видов, правило BAD_, числа QC, MNE-only-очистка |
| `docs/rules/filters.md` | фильтры: FIR/IIR и переходные полосы (N11), краевой буфер BAD_edge (N12), гармоники notch (N13), АЧХ и подпись «треки без фильтра» (N14) |
| `docs/rules/dipoles.md` | раздел «Диполи»: проекции, быстрый расчёт, воспроизведение, таблица, формы фильтров, **принципы пакетного сценария** (поддиапазоны, GOF не сравним между полосами) |
| `docs/rules/atlas-mri.md` | срез МРТ, анатомические структуры и поля Бродмана |
| `docs/rules/eeg.md` | раздел «ЭЭГ»: трек канала и спектрограмма |
| `docs/rules/api-jobs.md` | инвентарь роутов, правило «задача = job», ETag/304, ошибки |
| `docs/rules/frontend-state.md` | разделы, zustand-срезы, персист, «UI не запускает обработку» |
| `docs/rules/data-and-caches.md` | инварианты кэшей и артефактов, отпечаток ассетов, файл задачи |
| `docs/rules/safety.md` | правила безопасности и дрейф MNE API |
| `docs/rules/frontend-perf.md` | производительность клиента: замеры, отрисовка, границы воркеров/GPU |
| `docs/rules/tests.md` | покрытие (767 Vitest / 488 pytest), ruff/mypy и CI |
| `docs/rules/docs.md` | правило ведения документации (куда писать новое правило) |
| `docs/data_map.md` | что где лежит: кэши, файлы, БД, localStorage, ключи инвалидации, формат журнала шагов |
| `docs/ui.md` + `docs/ui/*.md` | функциональная спецификация UI (номера §) и дорожная карта |
| `docs/strategy.md` + `docs/strategy/*.md` | стратегия: видение (части 1–4), Часть 1 — качество сигнала и реставрация |
| `docs/history.md` | журнал закрытых работ (сюда переносится закрытое из `todo.md`) |
| `audit.md`, `audit-2026-09.md`, `audit_strategy.md` | долг и находки: F17–F21, A1–A11, P1–P9 (клиент, §7), N1–N40 (вердикты по направлениям) |
| `todo.md` | только открытые задачи (≤1 экрана) |
| `README.md`, `frontend/README.md` | запуск проекта и детали фронтенда |

**Добавляете длинное правило — заводите файл в `docs/rules/` и строку в таблице выше.** `AGENTS.md`
остаётся входом: он читается агентом целиком, поэтому его размер — часть контракта.

## Тесты (кратко)

Фреймворки: **pytest** (`backend/tests/`, конфиг `backend/pytest.ini`) и **Vitest** (`frontend/src/**/*.test.tsx`);
команды — выше. Тесты быстрые (без сети, синтетический ЭЭГ `backend/tests/conftest.py` + `TestClient`):
ветки с реальными данными (`~/mne_data`, `data/edf/test.edf`) помечаются маркером `integration` и
скипаются без них. `ruff`/`mypy` и тесты гоняет CI (`.github/workflows/ci.yml`): **изменение готово,
когда линтер и типы чисты** (конфиг — `backend/pyproject.toml`).
**Правило:** новый сервис/багфикс → тест (backend → pytest, frontend → Vitest). Инвентарь покрытия и
замеры чисел тестов — `docs/rules/tests.md`.

## Ключевые правила безопасности (кратко)

- Не передавать в `head_to_mni` путь-строку вместо `mne.Transform` (использовать `mne.read_trans`).
- CORS: не комбинировать `allow_origins=["*"]` с `allow_credentials=True`; размер загружаемых EDF валидировать.
- MNE API дрейфует между версиями (`psd_welch`→`compute_psd`, `fit_dipole` → **кортеж** и др.) —
  проверяйте актуальный API тестами, список — `docs/rules/safety.md`.
- Фильтровать band-specific фильтром continuous **raw** до нарезки, а не короткие эпохи.

Остальные правила (форматы `DPS1`/`DPS2`, дедуп загрузок, BEM fsaverage, ассеты МРТ и атласа,
слои визуализации, экспорт окна) — `docs/rules/safety.md`. Данные и их жизненный цикл — `docs/data_map.md`.
