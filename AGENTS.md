# AGENTS.md — инструкции для ИИ-агентов (DipLock)

> Файл читается автоматически ИИ-агентами. Архитектура — `docs/structure.md`;
> итоги аудитов и план — `audits/audit_summary_2026-10-15.md`. Размер файла — часть
> контракта (≤15 КБ, страж `backend/tests/test_docs_guards.py`).

## Обзор

FastAPI-бекенд + React/TS-фронтенд для анализа ЭЭГ: EDF → артефакты → эпохи → фильтры →
диполи → 3D-локализация. Стек: **Python 3.12, FastAPI, MNE-Python, SQLAlchemy (SQLite/dev,
PostgreSQL/prod)**; UI — **Vite 6 + React 19 + TypeScript (strict) + Tailwind CSS v4 +
TanStack Query + zustand**. Данные FSAverage (FreeSurfer) — локально в `~/mne_data/`.

## Команды

```bash
# --- backend ---
cd backend && python -m venv venv
venv/bin/pip install -r requirements.txt              # + requirements-dev.txt
venv/bin/uvicorn app.main:app --reload --port 8000    # рабочая директория — backend/
venv/bin/python -m pytest                             # тесты backend
venv/bin/ruff check app tests scripts alembic         # линтер (backend/pyproject.toml)
venv/bin/mypy app alembic                             # проверка типов
venv/bin/alembic upgrade head                         # схема БД (только alembic)
venv/bin/alembic revision --autogenerate -m "..."     # новая миграция после правки моделей

# проверка API (Swagger: /docs)
curl http://localhost:8000/health        # {"status":"ok",...}
curl http://localhost:8000/init-status   # готовность MNE/БД/fsaverage + версии/пути
curl http://localhost:8000/api/v1/meta   # версии, параметры расчёта, surface_version

# --- frontend ---
cd frontend && npm install
npm run dev        # http://localhost:5173/ui/ (proxy /api → :8000, CORS не нужен)
npm run test       # Vitest (jsdom)
npm run typecheck  # tsc --noEmit
npm run lint       # ESLint 9
npm run build      # → ../backend/app/static/ui (раздаётся FastAPI по /ui/)
npm run build:watch # автосборка туда же при правках: :8000/ui/ не отдаёт устаревший бандл
npm run gen:api    # TS-типы: src/shared/api/openapi.json → schema.d.ts (4.2)
```

Детали фронтенда — `frontend/README.md`.

## Структура

Полное дерево модулей с комментариями — `docs/structure.md`. Ключевое:

```
backend/app/
├── main.py            # FastAPI entry: CORS, gzip, /ui; lifespan: сироты, схема БД, задачи
├── core/config.py     # Pydantic-settings — ЕДИНЫЙ источник конфига
├── api/               # роуты + адаптеры HTTP: routes.py, params.py (формы/400),
│                      #   recording_jobs.py, consilium.py, llm_router.py, uploads.py
├── schemas/           # Pydantic-контракт ответов (OpenAPI → TS-типы UI)
├── models/db.py       # SQLAlchemy модели (пишется только legacy-анализ) + init_db (alembic)
├── services/          # КАЖДЫЙ модуль = один шаг пайплайна (55 модулей + consilium/, audio_render/)
└── utils/             # brain_export, versions, png, marching_squares, robust
frontend/              # UI (Vite+React+TS), сборка → backend/app/static/ui
data/                  # локальные данные (edf/results/cache) — НЕ коммитить
docs/                  # rules/ — правила, ui.md + ui/ — спецификация, data_map.md, history.md
audits/                # архив аудитов (версируется; личные срезы владельца — вне git)
```

## Конвенции

- **DRY**: частотные диапазоны (`freq_bands`), длины эпох, пороги — из `core/config.py`.
- **Не хардкодить пути `/home/...`** — только из `settings`/окружения.
- Типизация: все подписи функций с аннотациями типов; докстринги на русском.
- **Async**: НЕ выполняйте тяжёлые MNE/CPU-операции в `async def` — `asyncio.to_thread` /
  job-очередь; классы ресурса `mne`/`llm`/`asr`.
- **Контракт API** — Pydantic в `app/schemas/` (+`response_model`); из OpenAPI генерируются
  TS-типы (`npm run gen:api`; выгрузку обновляет
  `venv/bin/python -m scripts.export_openapi`, свежесть обоих файлов ловят стражи — pytest и
  CI); «сырые» dict в ответах не добавляем.
- **Схема БД — только через alembic** (`backend/alembic/`): правка моделей →
  `venv/bin/alembic revision --autogenerate`; `init_db` поднимает файл до head (мемоизирован;
  первый вызов — в `lifespan`), паритет моделей и миграций — страж `tests/test_migrations.py`.
  `Base.metadata.create_all` в сервисах не используем.
- **Тяжёлые статические ассеты** (меш fsaverage, BA-индексы) — только отдельными
  кэшируемыми эндпоинтами (`app/services/surface_cache.py`), никогда внутри `/analyze`.
- **Роут = форма и контракт, работа — в слое ниже**: приём файла (`api/uploads.py`), разбор
  формы и 400-тексты (`api/params.py`), задачи записи (`api/recording_jobs.py`),
  расчёты (`services/*`).
- **Ассеты — только через `app/api/assets.py`** (`asset_response`): ETag, `Cache-Control` и
  304 в одном месте, ручных `status_code=304` в роутах нет — ловит `tests/test_api_assets.py`.
- Один шаг пайплайна = один модуль в `services/`, без смешивания ответственности.
- Кэшируйте ресурсоёмкое (поверхности FSAverage, transform, labels).
- **Данные — только через свои сервисы:** кэши — `cache_store.py`, подготовленный сигнал —
  `prepared_signal.py`, версии ассетов — `asset_versions.py`, результат задачи — `job_store.py`,
  сироты — `orphans.py`, **строки БД результатов — `recording_store.py`/`results_store.py`**;
  инварианты — `docs/rules/data-and-caches.md`, `docs/rules/results-db.md`.
- **Frontend**: новый раздел UI = запись в `frontend/src/app/sections/registry.ts` + компонент
  в `routes.tsx`; тексты — на русском; ожидание и отмена задач — общие
  (`shared/lib/jobPolling.ts`), адреса — парами (`recordingJob(kind)`); контролы — из
  `shared/ui/` (состав — `docs/rules/frontend-state.md`).

## Ловушки

- **Frontend:** `className` ссылки рейла обязан быть строкой, а правка параметра **не**
  запускает расчёт (считает только кнопка) — `docs/rules/frontend-state.md`.
  **Правки UI видны на :8000/ui/ только после `npm run build`** — иначе раздаётся прошлый
  бандл и «правка не работает» при живом коде (случай 24.09.2026). Держите `npm run build:watch`;
  на :5173/ui/ правки видны сразу (Vite dev). Vite dev может отдать **залипший
  трансформ-кэш промежуточной правки** (симптом: гибрид старого и нового поведения;
  лечение — перезапуск `npm run dev`, случай 24.09.2026).
- **Backend:** правки backend видны в API только после перезагрузки процесса — держите
  uvicorn с `--reload`. Признак устаревшего процесса — `init-status.code.stale=true`
  («Состояние сервера» → «Код бэкенда»): перезапустите сервер **кнопкой «Перезапустить бэкенд»** (режим лаунчера) и **«Пересчитайте» запись** — файлы задач
  и результаты стадий переживают перезапуску и показывают старые числа (случай 24.09.2026).

## НЕ коммитить

`venv/`, `__pycache__/`, `.env`, `data/results/`, `*.db`, `data/llm_router.json` (API-ключи ИИ),
`data/protocols/` (черновики приёмки), `audits/audit_dsh.md` и
`audits/audit_sol_61.md` (личные срезы владельца) — см. `.gitignore`. `.env` содержит локальные
пути/настройки — шаблон: `backend/.env.example`.

## Карта документации

`AGENTS.md` — вход (≤15 КБ): обзор, команды, структура, конвенции. Правила живут по темам:

| Куда смотреть | Что там |
|---|---|
| `concept.md`, `docs/data-blocks.md` | миссия, критерии метода, способности; кирпичики данных |
| `docs/rules/edf-viewer.md` | вьюер треков: интерактив, разметка эпох, оверлеи |
| `docs/rules/events.md` | события и ERP: EDF+-аннотации/маркеры, `kind=evoked` |
| `docs/rules/artifacts.md` | артефакты: каталог 11 видов, правило BAD_, QC-числа |
| `docs/rules/filters.md` | фильтры: FIR/IIR, полосы/края/notch/АЧХ (N11–N14) |
| `docs/rules/dipoles.md` | «Диполи»: проекции, расчёт, таблица, пакетный сценарий |
| `docs/rules/atlas-mri.md` | срез МРТ, структуры и поля Бродмана |
| `docs/rules/eeg.md` | «ЭЭГ»: трек канала и спектрограмма |
| `docs/rules/api-jobs.md` | инвентарь роутов, «задача = job», ETag/304, ошибки |
| `docs/rules/compare.md`, `docs/rules/group-analysis.md` | сравнение пары (B9); групповой анализ N>2 (4.7) |
| `docs/rules/consilium.md` | Консилиум: Т1–Т6, модельный роутер ИИ |
| `docs/rules/emolab.md` | «ЕмоЛаб»: аудио, ФФТ/VAMP, звезда реакции, Эмограмма |
| `docs/rules/interviews.md` | беседа: аудио, стенограмма, микрофон |
| `docs/rules/neuromusic.md`, `docs/rules/spatial-audio.md` | «Нейромузыка», пространственная обработка |
| `docs/rules/frontend-state.md` | разделы, zustand-срезы, «UI не запускает обработку» |
| `docs/rules/data-and-caches.md` | инварианты кэшей/артефактов, отпечатки, файл задачи |
| `docs/rules/results-db.md` | база результатов (4.4): write-API, «история не UPSERT», TTL, PHI |
| `docs/rules/safety.md` | безопасность и дрейф MNE API |
| `docs/rules/frontend-perf.md` | производительность клиента: замеры, воркеры/GPU |
| `docs/rules/tests.md` | покрытие тестов, ruff/mypy и CI |
| `docs/rules/docs.md` | правило ведения документации |
| `docs/rules/wiki.md` | раздел «Wiki»: руководство, глоссарий |
| `docs/data_map.md` | что где лежит: кэши, файлы, БД, localStorage, журнал |
| `docs/ui.md` + `docs/ui/*.md` | спецификация UI (номера §) и дорожная карта |
| `docs/strategy.md` + `docs/strategy/*.md` | стратегия, части 1–5 (качество сигнала, Консилиум) |
| `docs/structure.md` | дерево модулей backend/frontend с комментариями |
| `docs/history.md` | журнал закрытых работ (сюда переносится закрытое из `todo.md`) |
| `audits/*.md` | архив аудитов (F/A, N1–N40, OM); `audit_summary_2026-10-15.md` — план |
| `todo.md` | только открытые задачи (≤1 экрана) |
| `docs/session-start.md` | памятка агенту: состояние среза, чек-лист, следующий шаг |
| `README.md`, `frontend/README.md` | запуск проекта, детали фронтенда |

**Добавляете длинное правило — заводите файл в `docs/rules/` и строку в таблице выше.**
Размер `AGENTS.md` — часть контракта: он читается агентом целиком.

## Тесты (кратко)

Фреймворки: **pytest** (`backend/tests/`, конфиг `backend/pytest.ini`) и **Vitest**
(`frontend/src/**/*.test.tsx`); команды — выше. Тесты быстрые (без сети, синтетический ЭЭГ
`backend/tests/conftest.py` + `TestClient`); ветки с реальными данными помечаются маркером
`integration` и скипаются без них. `ruff`/`mypy` и тесты гоняет CI
(`.github/workflows/ci.yml`): **изменение готово, когда линтер и типы чисты**
**Правило:** новый сервис/багфикс → тест (backend →
pytest, frontend → Vitest). Инвентарь покрытия — `docs/rules/tests.md`; стражи документации
(размер `AGENTS.md`, `todo.md` без закрытого, файлы карты) — `backend/tests/test_docs_guards.py`.

## Ключевые правила безопасности (кратко)

- `head_to_mni` — только `mne.Transform` (`mne.read_trans`), не путь-строка.
- CORS: не комбинировать `allow_origins=["*"]` с `allow_credentials=True`; размер EDF валидировать.
- MNE API дрейфует между версиями (`psd_welch`→`compute_psd`, `fit_dipole` → **кортеж** и др.) —
  проверяйте актуальный API тестами, список — `docs/rules/safety.md`. `DeprecationWarning`
  глобально не подавляем — это сигнал дрейфа (конфиг `backend/pytest.ini`).
- Фильтровать band-specific фильтром continuous **raw** до нарезки, а не короткие эпохи.

Остальные правила (DPS1/DPS2, дедуп загрузок, BEM fsaverage, ассеты МРТ/атласа, слои, экспорт окна) — `docs/rules/safety.md`. Данные и их жизненный цикл —
`docs/data_map.md`.
