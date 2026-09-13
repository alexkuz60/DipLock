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
venv/bin/pip install -r requirements.txt              # + requirements-dev.txt для тестов
venv/bin/uvicorn app.main:app --reload --port 8000    # рабочая директория — backend/
venv/bin/python -m pytest                             # тесты backend

# проверка API
curl http://localhost:8000/health        # {"status":"ok",...}
curl http://localhost:8000/init-status   # готовность MNE/БД/fsaverage + versions/paths/ui
curl http://localhost:8000/api/v1/meta   # версии, параметры расчёта, surface_version
# Swagger: http://localhost:8000/docs

# --- frontend ---
cd frontend && npm install
npm run dev        # http://localhost:5173/ui/ (proxy /api → :8000, CORS не нужен)
npm run test       # Vitest (jsdom)
npm run typecheck  # tsc --noEmit
npm run lint       # ESLint 9
npm run build      # → ../backend/app/static/ui (раздаётся FastAPI по /ui/)
```

Спецификация UI и дорожная карта фаз — `docs/ui.md`; детали фронтенда — `frontend/README.md`.


## Структура

```
backend/app/
├── main.py            # FastAPI entry: CORS (5173), gzip, раздача /ui (сборка frontend) и /legacy
├── core/config.py     # Pydantic-settings — ЕДИНЫЙ источник конфига
├── api/routes.py      # /analyze, /jobs, /surface(+brodmann), /brodmann-labels, /meta
├── schemas/           # Pydantic-контракт ответов (OpenAPI → TS-типы UI)
├── services/          # КАЖДЫЙ модуль = один шаг пайплайна
│   ├── edf_loader.py  # read_raw_edf → pick/montage/reference/filter
│   ├── artifact_detector.py
│   ├── epoch_segmenter.py
│   ├── bandpass_filter.py
│   ├── dipole_fitter.py
│   ├── recordings.py      # реестр записей просмотра: паспорт, TTL (2.2)
│   ├── recording_signals.py # пирамида сигналов вьюера: огибающая ×1…×16, кэш (2.5)
│   ├── job_manager.py     # фоновые задачи: этапы, прогресс, семафор (F7)
│   └── surface_cache.py   # кэш меша/BA на диске + ETag/304 (F6)
├── models/db.py       # SQLAlchemy модели (Session, Epoch, Dipole)
└── utils/             # brain_export.py, versions.py
frontend/              # UI (Vite+React+TS), сборка → backend/app/static/ui
data/                  # локальные данные (edf/results/cache) — НЕ коммитить
docs/ui.md             # спецификация UI и дорожная карта фаз
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
- Один шаг пайплайна = один модуль в `services/`, без смешивания ответственности.
- Кэшируйте ресурсоёмкие объекты (поверхности FSAverage, transform, labels).
- **Frontend**: новый раздел UI = запись в `frontend/src/app/sections/registry.ts` + компонент в
  `routes.tsx`; UI-тексты и подсказки — на русском, конвенции — `frontend/README.md`.
- **UI не запускает обработку сам** (важно): параметры раздела живут в zustand-срезе
  (`shared/state/`), правка параметра только помечает результат устаревшим и **не делает запросов**;
  расчёт стартует исключительно по кнопке (`POST /api/v1/jobs`) — сначала контролы и визуализация
  (можно на фикстурах), затем подключение расчёта. Новые контролы берите из `shared/ui/`
  (`FieldRow`, `SegmentedControl`, `SelectField`, `NumberField`, `CheckboxRow`, `StatusPill`).

## НЕ коммитить

- `venv/`, `__pycache__/`, `.env`, `data/results/`, `*.db` — см. `.gitignore`.
- `.env` содержит локальные пути/настройки — вместо него есть `.env.example`.

## Тесты

Фреймворки: **pytest** (`backend/tests/`, конфиг `backend/pytest.ini`) и **Vitest** (`frontend/src/**/*.test.tsx`).

```bash
cd backend && venv/bin/pip install -r requirements-dev.txt
cd backend && venv/bin/python -m pytest                        # все тесты backend
cd backend && venv/bin/python -m pytest tests/test_api.py -v
cd backend && venv/bin/python -m pytest -m "not integration"   # без локальных данных

cd frontend && npm run test                                    # Vitest (jsdom)
```

Тесты быстрые (без сети): синтетический ЭЭГ (`backend/tests/conftest.py`) + `TestClient`; ветки с
реальными данными (`~/mne_data`, `data/edf/test.edf`) помечаются маркером `integration` и скипаются
без них. Покрывают: контракт API и Pydantic-схемы, job-API и прогресс, кэш поверхности (ETag/304),
санитизацию загрузок, сигналы записи (формат `DPS1`, ETag/304, уровни, кэш), config, bandpass_filter,
epoch_segmenter, montage edf_loader; на UI — каркас
(рейл, тулс-хедер, панели, хоткеи), реестр разделов, «Главная», «Настройки», «Состояние сервера»,
HTTP-клиент и разбор ошибок, контролы правой панели, параметры раздела EDF, загрузка записи
(`EdfSection`), вьюер треков (`viewer/TrackStack` — с моком uPlot, математика окна/огибающей в
`viewerMath.test.ts`, разбор контейнера сигналов в `signalFrame.test.ts`, энкодер для тестов —
`test/signalBlob.ts`) и тулс-хедер раздела (`EdfToolActions` +
`EdfRecalcButtons`, диалог паспорта `SessionPassportDialog`, стор записи `edfRecording.test.ts`).
**Правило:** новый сервис/багфикс → тест (backend → pytest, frontend → Vitest).

## Правила безопасности

- Не передавать в `head_to_mni` путь-строку вместо `mne.Transform` (использовать `mne.read_trans`).
- CORS: не комбинировать `allow_origins=["*"]` с `allow_credentials=True`.
- Валидировать размер загружаемых EDF-файлов.
- MNE API дрейфует между версиями: `psd_welch`→`compute_psd`, `standard_1020`→`colin27_1020`,
  `read_labels_from_parc`→`read_labels_from_annot`, `baseline` по умолчанию `(None, 0)`.
  Проверяйте актуальный API через тесты.
- Фильтровать band-specific фильтром continuous **raw** до нарезки, а не короткие эпохи.
- Единицы EDF: часть файлов без physical dimension MNE читает как «вольты» (в 1e6 раз больше) —
  есть авто-детект масштаба (`_ensure_physical_units`) и переменная `EDF_UNITS`.
- Brodmann-атлас — `PALS_B12_Brodmann` (метки `Brodmann.N`), а не `aparc.a2009s`; нужен `nibabel`.
- BEM fsaverage: `fsaverage/bem/fsaverage-5120-5120-5120-bem-sol.fif`; average reference должна быть
  применена (`projection=False`), иначе `mne.fit_dipole` падает.
- `mne.fit_dipole` требует `Evoked` (не массив) и дорог — используйте `dipole_fit_decim`.
- Сигналы вьюера (2.5) отдаются **бинарным контейнером** `DPS1` (magic + uint32 LE + JSON-заголовок +
  float32 LE, канало-мажорно), а не JSON: 64k точек × 18 каналов в JSON не влезают. Чтение EDF —
  `preload=False` блоками; единицы контейнера всегда мкВ (опора на `units_autoscaled`, не на повторный
  авто-детект), min/max считаются по корзинам одним `get_data`-блоком с
  `np.minimum/maximum.reduceat`, уровни вне `signal_levels` → 400. Формат меняется только синхронно в
  `backend/app/services/recording_signals.py`, `backend/app/schemas/analysis.py`
  (`RecordingSignalsHeader`) и `frontend/src/shared/lib/signalFrame.ts`.
- Слои визуализации (огибающая треков) считаются min/max по корзине, а не «каждый N-й отсчёт»: иначе
  прореживание срезает пики артефактов — то, ради чего раздел существует. Пирамида сигналов строится
  лениво при первом запросе уровня и кэшируется на диске; уровни задаются `SIGNAL_LEVELS`, бюджет точек
  на ×1 — `SIGNAL_BASE_POINTS`.
