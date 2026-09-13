# Audit.md — Аудит реализации DipLock

> **Дата:** 12.09.2026
> **Аудитор:** Cline (сторонний взгляд)
> **Статус:** Проведён полный разбор backend-кода; рекомендации по приоритетам.

---

## 1. Резюме

Проект — FastAPI-bevend для EEG-анализа (EDF → диполи → 3D-локализация FSAverage).
Общее качество **хорошее для MVP**, архитектура сервисов понятная. Есть несколько
критических проблем (асинхронность, неэффективные алгоритмы, интеграция БД,
docker-fsaverage), которые стоит исправить до масштабирования.

---

## 2. Согласен — сделано правильно

| Решение | Комментарий |
|---|---|
| Сервисная архитектура (`services/` — один модуль на шаг пайплайна) | Идеально для MVP, легко тестировать/заменять |
| Pydantic-Settings для конфига (`core/config.py`) | Единая точка конфигурации с типами и дефолтами |
| FastAPI + автодокументация `/docs` | Swagger из коробки, валидация типов |
| Жёсткие лимиты длины эпох `[250…2000]` мс без overlap | Детерминированно, соответствует требованиям README |
| `mne.fit_dipole` + локализация (MNI/anatomy/Brodmann) | Правильный научный стек |
| `requirements.txt`, `Dockerfile`, `.dockerignore` | Контекст сборки уменьшен с 360 МБ до 24 КБ |
| SQLite для локали / PostgreSQL в docker | Верное разделение для dev/prod |

---

## 3. Критические проблемы (исправляются)

### 3.1 Блокирующие операции в `async`-хэндлере
**Файл:** `backend/app/api/routes.py` — `/analyze`
**Проблема:** тяжёлая MNE-обработка (EDF → эпохи → диполи) выполняется НАПРЯМУЮ
в `async def`. Блокирует event-loop: один запрос `/analyze` «замораживает» весь API.
**Решение:** вынести в `run_in_executor`, а долгие задачи в будущем — в Celery/очередь.

### 3.2 Неэффективный поиск Brodmann Area
**Файл:** `backend/app/services/dipole_fitter.py` — `_find_ba`
**Проблема:** `read_surface(...)` выполняется внутри цикла по каждой BA-метке
для каждого диполя (O(метки × диполи) чтений с диска).
**Решение:** закэшировать поверхности и центры меток один раз.

### 3.3 Некорректный вызов `mne.head_to_mni`
**Файл:** `dipole_fitter.py`
**Проблема:** вызов `head_to_mni(pos, 1, trans, ...)`. В MNE 1.13.2 сигнатура
`(pos, subject, mri_head_t, subjects_dir=None)` — передаётся `subject=1` и путь-строка
вместо объекта `Transform`. Функция падает или возвращает мусор.
**Решение:** `mne.read_trans(...)` для получения `mri_head_t`, корректные аргументы.

### 3.4 База данных не интегрирована в пайплайн
**Файл:** `routes.py` / `models/db.py`
**Проблема:** `/analyze` пишет результат только в JSON. SQLAlchemy-модели не
вызываются в основном флоу → БД «мёртвый код», требование №7 README не выполнено.
**Решение:** сохранять Session/Epoch/Dipole в БД внутри `/analyze`.

### 3.5 Docker-запуск неработоспособен (отложено)
**Проблема:** `.env` содержит пути `/home/alexkuz60/...`, которых нет внутри
контейнера. FSAverage-данные не смонтированы томами. `docker compose up` упадёт.
**Решение:** отложено по решению владельца (только локальная разработка).
→ перенесено в `todo.md`.

---

## 4. Серьёзные, но не блокирующие

| Файл | Проблема | Решение |
|---|---|---|
| `config.py` + `bandpass_filter.py` + `epoch_segmenter.py` | Дублирование `freq_bands`/длин эпох (DRY) | Импорт из `config` |
| `routes.py` | Нет лимита размера файла, нет try/except → 500 | Валидация + `HTTPException` |
| `config.py` | Хардкод путей `/home/alexkuz60/...` | Дефолты из окружения |
| `db.py` vs `init_db.sql` | Схемы не полностью синхронны; alembic не настроен | Синхронизировать, подключить alembic |
| `artifact_detector.py` | Смешение `settings` + явных порогов; ICA почти всегда вырожден | Единый конфиг |
| `epoch_segmenter.py` | Комментарий «пометим» ≠ код (reject отбрасывает) | Поправить комментарий |
| `main.py` | `/init-status` громоздкий; кода-отступ | Вынести проверки |
| `brain_export.py` | `settings or Settings()` перечитывает `.env`; децимация каждый раз | Кэш |
| `docker-compose.yml` | `redis` не используется; CS password захардкожен | Убрать/вынести в env |
| `main.py` (CORS) | `allow_origins=["*"]` + `allow_credentials=True` | Явные origins, без credentials |

---

## 5. Мелочи

- Нет `LICENSE` (публичный репо) → добавлена `LICENSE` (MIT).
- `Dockerfile` без `HEALTHCHECK`.
- `compute_band_power` считает PSD заново для каждой полосы → один PSD + нарезка.

---

## 6. Приоритеты (бэклог)

1. 🔥 Исправить async-блокировки `/analyze`
2. 🔥 Кэш `_find_ba` + корректный `head_to_mni`
3. 🔥 Интеграция БД в `/analyze`
4. 🔥 Docker fsaverage — **отложено** (см. `todo.md`)
5. 🔸 DRY-config, валидация входа, CORS-политика, LICENSE
6. 🔹 Alembic миграции, HEALTHCHECK, оптимизация PSD

---

---

*Документ создан в рамках планового аудита. Рекомендации применяются постепенно.*

---

## ✅ РЕАЛИЗОВАНО (12.09.2026)

Пункты аудита, исправленные в ходе этой сессии:

| Пункт | Решение | Проверено |
|---|---|---|
| **3.1** Async-блокировки `/analyze` | Вынос в `asyncio.to_thread` (executor), event-loop не блокируется | ✅ сервер + 400-валидация |
| **3.2** Неэффективный `_find_ba` | Кэш `_get_ba_centers` через `lru_cache` — поверхности читаются 1 раз | ✅ импорт + сервер |
| **3.3** Некорректный `head_to_mni` | `mne.read_trans` → `mri_head_t`; верная сигнатура MNE 1.13 | ✅ импорт + сервер |
| **3.4** БД не интегрирована | `_save_analysis_to_db` — Session + Dipole пишутся в `/analyze`; `db.py` берёт URL из `settings` | ✅ запись в SQLite |
| **4.x** DRY `freq_bands`/длины эпох | Импорт из `config.py`; оптимизирован `compute_band_power` (1 PSD) | ✅ импорт |
| **4.x** Валидация входа `/analyze` | Лимит размера, `.edf`, `epoch_length_ms`, `freq_band`, `single_freq` | ✅ 400-ответы |
| **4.x** CORS `*` + credentials | Конкретные origins из env, без `*` | ✅ сервер |
| **4.x** `brain_export` перечитывал `.env` | Использует глобальный `settings` | ✅ импорт |
| **4.x** Нет LICENSE / AGENTS.md / audit.md | Добавлены `LICENSE` (MIT), `AGENTS.md`, `audit.md` | — |
| **3.5** Docker fsaverage | **ОТЛОЖЕНО** — перенесено в `todo.md` | — |

**Открытыми остаются** (см. `todo.md`): alembic-миграции, контейнерная интеграция fsaverage, HEALTHCHECK.

---

## 🐞 Баги, найденные автотестами (12.09.2026)

Подключён `pytest` (`backend/tests/`, 54 теста). Прогон пайплайна и реального
EDF вскрыл **17 дефектов**, из-за которых `/analyze` не работал на реальных данных:

| # | Симптом | Причина | Файл | Фикс |
|---|---|---|---|---|
| 1 | `ValueError: Baseline interval is only one sample` | MNE по умолчанию берёт `baseline=(None, 0)`, а при `tmin=0` это 1 сэмпл | `services/epoch_segmenter.py` | явный `baseline=None` |
| 2 | `AttributeError: No mne.time_frequency attribute psd_welch` | API удалён в MNE ≥ 1.10 | `services/bandpass_filter.py` | `epochs.compute_psd(method="welch")` |
| 3 | `ValueError: n_fft ... > n_times` (эпохи ≤ 1 с) | жёсткий `n_fft=256` больше длины сигнала | `services/bandpass_filter.py` | `n_fft=min(256, len(n_times))` |
| 4 | `ValueError: Ни один из стандартных каналов не найден` | имена `"EEG F7"`, `T3/T4/T5/T6` не совпадали со стандартом 10-20 | `services/edf_loader.py` | `normalize_channel_name()` (префиксы + алиасы T3→T7…) |
| 5 | `AttributeError: 'str' object has no attribute 'copy'` | `resample(events="auto")` — `events` принимает массив, не строку | `services/edf_loader.py` | `resample(500.0)` только при `sfreq > 500` |
| 6 | FutureWarning → поломка в MNE 1.14 | montage `standard_1020` переименован | `services/edf_loader.py` | `colin27_1020` + fallback на старое имя |
| 7 | `RuntimeWarning: filter_length > signal` (искажение спектра) | band-фильтр применялся к коротким эпохам (250–1000 мс) | `api/routes.py`, `bandpass_filter.py` | фильтровать continuous **raw** до нарезки |
| 8 | `RuntimeError: this Epochs-object is empty` | EDF без physical dimension: данные в µV читались как «вольты» (x1e6), reject 150 мкВ отбросил все эпохи | `services/edf_loader.py`, `epoch_segmenter.py` | авто-детект масштаба + `EDF_UNITS` + понятная ошибка вместо пустых эпох |
| 9 | `AttributeError: 'numpy.ndarray' object has no attribute 'average'` | итерация по `Epochs` даёт массивы, а `fit_dipole` требует `Evoked` | `services/dipole_fitter.py` | сборка `EvokedArray` на каждую эпоху |
| 10 | `AttributeError: No mne attribute read_labels_from_parc` | такого API в MNE нет | `dipole_fitter.py`, `api/routes.py` | `mne.read_labels_from_annot` |
| 11 | Все BA = `unknown` | атлас Brodmann — `PALS_B12_Brodmann`, метки `Brodmann.N`; в `aparc.a2009s` их нет | `dipole_fitter.py`, `api/routes.py` | parc=`PALS_B12_Brodmann`, префикс `Brodmann`, имя `BA<N>` |
| 12 | BA-центры всегда из правого полушария | `label.hemi` = `'lh'/'rh'`, а сравнивалось с `'L'` | `dipole_fitter.py` | `hemi = label.hemi` |
| 13 | `FileNotFoundError` BEM; `EEG average reference is mandatory` | путь `bem/fsaverage-5-embed-mri.bem` не существовал; average reference была отложенной проекцией | `dipole_fitter.py`, `edf_loader.py` | поиск реального `fsaverage-5120-5120-5120-bem-sol.fif`; `set_eeg_reference(projection=False)` |
| 14 | `ModuleNotFoundError: nibabel` | отсутствовал в зависимостях | `requirements.txt` | `nibabel>=5.0.0` |
| 15 | `ValueError: scikit-learn is not installed` | `compute_covariance(method='shrunk')` требует sklearn | `dipole_fitter.py` | `method='empirical'` (cov из эпох, если файла нет) |
| 16 | `AttributeError: module 'mne.surface' has no attribute 'io'` | `mne.surface.io.read_surface` не существует | `utils/brain_export.py` | `mne.read_surface` |
| 17 | Децимация меша молча не применялась (163842 вершины); `AttributeError: 'Trimesh' object has no attribute 'simplify_quadratic_decimation'` | неверное имя метода (`quadric`), в trimesh 5.x `face_count` — keyword-аргумент, отсутствовал `fast-simplification` | `utils/brain_export.py`, `requirements.txt` | `simplify_quadric_decimation(face_count=...)` + `fast-simplification` |

**Производительность:** `fit_dipole` по каждой временной точке эпохи (1000 точек) идёт
> 90 с/эпоху. Добавлено прореживание `dipole_fit_decim` (по умолчанию 10).

Все исправления покрыты тестами и подтверждены на реальном `data/edf/test.edf`.
**Вывод:** «зелёный» `/init-status` не гарантировал работоспособность пайплайна —
тесты обязательны (см. `AGENTS.md`).

---

## 7. Повторный аудит состояния проекта (13.09.2026)

> **Дата:** 13.09.2026
> **Аудитор:** Cline (повторный аудит «состояния проекта», без детального разбора кода)
> **Метод:** git-гигиена, окружение/зависимости, живой прогон pytest, наличие CI/линтеров/миграций,
> согласованность «документация ↔ код», измерение размера и кэшируемости API-ответов.
> **Контекст:** коммит `632d3ee`, ветка `main`, рабочее дерево чистое, синхронно с `origin/main`.

### 7.1 Состояние проекта (светофор)

| Зона | Статус | Факт (проверено/измерено) |
|---|---|---|
| Тесты | 🟢 | `54 passed, 11 warnings in 3.26 s`, exit 0; 6 файлов в `backend/tests/` |
| Git-гигиена | 🟢 | 5 коммитов, чистое дерево, `.env` в истории не появлялся, секретов в tracked-файлах нет, репо 5.4 МБ (`.git` 2.6 МБ) |
| Научные данные | 🟢 | `~/mne_data` = 762 МБ: BEM-sol, `fsaverage-trans.fif`, inflated-поверхности, `PALS_B12_Brodmann` |
| Окружение | 🟢 | venv Python 3.12.3, MNE 1.13.2, numpy 2.5.3, trimesh 5.1.0, fast-simplification 0.2.0, SQLAlchemy 2.0.52 |
| Документация | 🟡 | README/`todo.md` противоречат коду (см. F13) |
| Воспроизводимость | 🟡 | зависимости не запинены, `aiosqlite` не объявлен, Dockerfile на Python 3.11 |
| CI / качество кода | 🔴 | нет `.github/workflows`, нет ruff/black/mypy/pre-commit, нет coverage |
| Миграции БД | 🔴 | `alembic` в requirements, но нет `alembic.ini`/`versions/`; `init_db.sql` (Postgres UUID/JSONB) ≠ ORM-модели (String/JSON), `group_analysis` только в SQL |
| API-контракт | 🔴 | нет `response_model`/Pydantic-схем ответов → OpenAPI не описывает структуру результата |
| Frontend | 🔴 | только `backend/app/static/index.html` (поллинг `/init-status`), Этап 2 не начат |

**Вывод:** ядро пайплайна рабочее, блокирующих дефектов для старта Этапа 2 нет, но «всё ОК» — не про этот прогон:
критичны для UI четыре вещи — контракт API (F4), job/progress (F7), кэш и формат 3D-данных (F6),
CORS/расположение frontend (F14).

### 7.2 Новые находки

| # | Приоритет | Находка | Решение |
|---|---|---|---|
| F1 | 🔴 | Нет CI: тесты запускаются только вручную, документированный дрейф MNE-API (уже 17 багов) не ловится автоматически | GitHub Actions: Python 3.12, кэш pip + кэш `~/mne_data`, `pytest`; отдельный job `integration` |
| F2 | 🔴 | Нет линтеров/типизации, хотя `AGENTS.md` требует аннотации и докстринги | `pyproject.toml` + ruff (lint+format) + mypy + pre-commit |
| F3 | 🔴 | `requirements.txt` без пинов при задокументированном дрейфе API; `aiosqlite` не объявлен (а локальный `DATABASE_URL=sqlite+aiosqlite://…`); `alembic` объявлен и не используется; `asyncpg` + `psycopg2-binary` одновременно; Dockerfile Py 3.11 против 3.12 в venv/AGENTS.md | `pip-compile`/`uv` → lock-файл; добавить `aiosqlite`; убрать неиспользуемое; единая версия Python |
| F4 | 🔴 | `/analyze` и `/brain-surface` возвращают «сырые» `dict` → в Swagger нет схемы ответа; frontend придётся писать вслепую, изменения бэкенда ломают UI молча | Pydantic-модели (`AnalyzeResponse`, `DipoleOut`, `SurfaceOut`, `JobStatus`) + `response_model`; автогенерация TS-типов из OpenAPI |
| F5 | 🔴 | БД «write-only»: нет GET-эндпоинтов чтения; `EpochRecord` — мёртвая модель; `has_artifact` не пишется; в `Dipole.epoch_id` пишется `epoch_index` (FK-нарушение на PostgreSQL, на SQLite молча проходит); `init_db()`/`create_all` на каждый `/analyze` | ORM — источник истины + alembic-миграция; read-API (`/sessions`, `/sessions/{id}`, `/sessions/{id}/dipoles`); запись эпох с флагом артефакта; FK починить |
| F6 | 🟠 | Тяжёлый payload без кэша: `export_fsaverage_surface` = **2.86 МБ JSON** (из них `ba_labels` **2.06 МБ**, 82 метки, 280 960 индексов вершин), пересчитывается **1.6 с** на каждый вызов и вкладывается в **каждый** ответ `/analyze` | Предрассчитать меш/метки один раз (кэш на диске + `lru_cache`), отдавать отдельными эндпоинтами с gzip/`ETag`/`Cache-Control`; для 3D — бинарный формат (GLB/PLY/`.npz`); из `/analyze` surface убрать (только `surface_version`/URL) |
| F7 | 🟠 | Нет job-модели и прогресса: один долгий синхронный запрос = весь пайплайн; при обрыве соединения результат теряется; параллельность не ограничена; форм-параметр `run_ica` принимается и игнорируется | `POST /jobs` → 202 + `job_id`; `GET /jobs/{id}` (status/progress/result); исполнение в `ProcessPoolExecutor`/RQ (redis в compose объявлен и простаивает); `Semaphore` на параллелизм; прогресс по этапам пайплайна |
| F8 | 🟠 | Артефакты/эпохи не видны наружу: `reject=150 мкВ` захардкоден в `epoch_segmenter` (в config — `peak_to_peak_threshold_uv=100`), в ответе `n_epochs_total == n_epochs_used` всегда; ICA-ветка срабатывает только при наличии EOG-каналов (в `test.edf` их нет) → требование №3 README фактически не выполняется | Возвращать `drop_log`/статистику по эпохам и `has_artifact`; порог брать из `settings`; для EOG-free записей — ICA-компоненты + автомаркировка (`compute_bads_ic`) либо честно сузить требование в README |
| F9 | 🟠 | Переносимость путей: дефолты `config.py` всё ещё `/home/alexkuz60/…` (в блоке «РЕАЛИЗОВАНО», п. 4.x, помечено как исправленное — фактически нет), в `/init-status` хардкод-fallback'и `~/mne_data/…`, относительные `UPLOAD_DIR/RESULTS_DIR` зависят от CWD, дефолтный `DATABASE_URL` указывает на docker-хост `db` (локальный старт без `.env` падает) | `BASE_DIR`/`DATA_ROOT` + `Path`-дефолты, `expanduser` вместо литералов, дефолт БД — sqlite |
| F10 | 🟡 | Загрузки не удаляются после успеха (`rmtree` только в ветке ошибки); `os.path.join(upload_dir, file.filename)` без санитизации (абсолютное имя или `../` уходит за пределы каталога); при 413 остаётся частичный файл | `os.path.basename` + whitelist-суффикс, cleanup в `finally`, TTL-чистка `upload_dir` |
| F11 | 🟡 | Научные компромиссы не зафиксированы как ограничения: `decim=5` без антиалиасинг-фильтра (тесты дают RuntimeWarning: low-pass 125 Гц → 50 Гц после децимации); `compute_covariance(method="empirical")` без baseline-коррекции (scikit-learn не установлен → `shrunk` недоступен) → GOF может быть занижен | Low-pass ≤ 0.4·sfreq/decim перед децимацией; `baseline=(None, 0)` для Evoked при tmin<0; добавить `scikit-learn` и `method="shrunk"` |
| F12 | 🟡 | Тесты: нет coverage, нет тестов `artifact_detector`, нет e2e `/analyze` на реальном EDF (только 400-валидация), ключевые тесты скипаются без локальных данных (в CI просто пропустятся), `addopts=-q` в `pytest.ini` вместе с `-q` скрывает итоговую строку, starlette депрекает `httpx`-TestClient | Маркер `integration` + кэш fsaverage в CI; e2e-тест с `DIPOLE_FIT_MAX_EPOCHS=1`; `pytest-cov` + порог; тесты `artifact_detector` |
| F13 | 🟡 | Документация ↔ код: README называет `read_labels_from_parc` «правильным методом» (в коде — `read_labels_from_annot`); Docker-раздел обещает рабочий запуск (отложен); структура проекта не содержит `tests/`, `AGENTS.md`, `audit.md`, `LICENSE`, `requirements-dev.txt`; fallback-HTML в `main.py` ссылается на `/api/v1/docs` (реально `/docs`); `CORS_ORIGINS` не описан в `.env.example`; в разделе 6 этого файла «decim по умолчанию 10», в `config.py` — 5; опечатки («FastAPI-bevend», «диапазазы», «файдук»), сбитый отступ комментария в `main.py:95` | Ревизия README, единый `docs/architecture.md`, `CORS_ORIGINS` в `.env.example` |
| F14 | 🟡 | Готовность к UI: CORS-дефолт не содержит порт Vite (5173) — только 3000/8000; нет эндпоинта версии/схемы; не решено, где живёт frontend | Добавить 5173 (или задавать `CORS_ORIGINS` в `.env`); зафиксировать расположение frontend |
| F15 | 🟡 | Корневой `DipLock — сжатый стартовый пакет для VS Code (Cline).md` (970 строк, имя с пробелами и em-dash) неудобен в CLI/CI | Перенести в `docs/spec.md` (ASCII-имя), ссылка из README |
| F16 | 🟡 | Нет provenance результата: в JSON-дамп пишутся только `session_id`, `filename`, `frequency_powers`, `dipoles` — без версии MNE, порогов, `decim`, монтажа → результат невоспроизводим | В ответ и в дамп: блок `pipeline` (версии, параметры, пороги, время выполнения, host) |

### 7.3 Аргументированные сомнения

1. **«Один HTTP-запрос = весь пайплайн» — сомневаюсь, что эта модель переживёт UI.**
   *Аргумент:* при эпохах 2000 мс и `DIPOLE_FIT_DECIM=5` счёт идёт на десятки секунд–минуты (в разделе 6 зафиксировано «> 90 с/эпоху» до прореживания). Браузер и прокси обрывают длинные запросы, прогресса нет, повтор после обрыва — полный пересчёт, а каждый параллельный анализ — это поток и гигабайты RAM без ограничения.
   *Решение:* job-модель (F7) как P0 до старта UI — она же даёт UI прогресс-бар по этапам (загрузка → артефакты → фильтр → эпохи → PSD → диполи → локализация).

2. **JSON как транспорт 3D-данных — сомневаюсь.**
   *Аргумент:* 2.86 МБ на запрос, из них 2.06 МБ — индексы вершин BA-меток, которые не меняются никогда (статический атлас fsaverage), плюс 1.6 с пересчёта на каждый вызов и полное отсутствие кэша.
   *Решение:* статический предрассчитанный ассет (F6): меш — GLB/PLY (Draco) или `.npz`, BA-метки — отдельный эндпоинт по запросу, `Cache-Control: immutable` + `ETag`; в `/analyze` — только ссылка и версия.

3. **Нужна ли БД на локальном этапе — сомневаюсь в текущем виде.**
   *Аргумент:* БД пишется, но не читается; JSON-дамп в `results_dir` дублирует те же данные → два источника истины, ни один не используется; групповой анализ (требование №7) не реализован, `group_analysis` существует только в SQL.
   *Решение:* не удалять, а довести до смысла: ORM + alembic как единственная схема, read-API для истории сессий, JSON-дамп оставить только как debug-артефакт.

4. **«Всегда свежие» зависимости против воспроизводимости — сомневаюсь в выборе.**
   *Аргумент:* сам проект задокументировал, что дрейф MNE/trimesh API дал 17 багов; при этом все зависимости заданы как `>=`, lock-файла нет, Dockerfile на другой версии Python. Через месяц `pip install` даст другое окружение и другие баги.
   *Решение:* lock-файл + CI на зафиксированных версиях; обновление библиотек — отдельной осознанной задачей с прогоном тестов.

5. **Ценность «зелёных» тестов — сомневаюсь, что они защищают главное.**
   *Аргумент:* 54 теста проходят за 3.26 с именно потому, что тяжёлые ветки (fit_dipole, surface, BA) замокированы или скипаются без локальных данных; e2e `/analyze` на реальном EDF не тестируется вовсе. В CI без `~/mne_data` они просто пропустятся — «зелёный» CI не будет гарантировать работоспособность пайплайна (ровно тот вывод, что сделан в конце раздела 6).
   *Решение:* два уровня — быстрые unit (всегда) и `integration` (кэш fsaverage в CI + реальный `test.edf`), e2e-тест с `DIPOLE_FIT_MAX_EPOCHS=1`.

6. **Скорость против научной валидности — сомневаюсь, что компромиссы допустимы «молча».**
   *Аргумент:* `decim` без антиалиасинга (warning про 125 → 50 Гц) и `empirical`-ковариация без baseline-коррекции влияют на GOF и координаты диполей, то есть на научный результат, но в ответе и дампе не фиксируются (F16).
   *Решение:* два профиля — `fast` (превью в UI) и `accurate` (финальный расчёт) + обязательный блок provenance в результате.

### 7.4 Вариант решения (дорожная карта)

**P0 — до/в момент старта UI (≈0.5–1 день):** F4 (Pydantic response-модели), F6 (кэш surface + отдельные эндпоинты),
F7 (job API + прогресс), F14 (CORS 5173), F10 (санитизация имени + cleanup загрузок).

**P1 — параллельно с UI (≈1–2 дня):** F1 (CI), F3 (lock + `aiosqlite` + Python 3.12), F5 (read-API + alembic + FK),
F8 (drop_log и пороги из config), F16 (provenance), F9 (пути от `BASE_DIR`).

**P2 — после MVP UI:** F2 (ruff/mypy/pre-commit), F11 (научные профили), F12 (coverage + integration + e2e),
F13 (ревизия документации), F15 (`docs/spec.md`).

### 7.5 Требования UI к бэкенду (контракт для Этапа 2)

1. `POST /api/v1/jobs` → `202 {job_id}`; `GET /api/v1/jobs/{id}` → `{status, stage, progress, error, result_url}` (поллинг 1 с или SSE).
2. `GET /api/v1/sessions`, `GET /api/v1/sessions/{id}`, `GET /api/v1/sessions/{id}/dipoles` — история и повторный просмотр без пересчёта.
3. `GET /api/v1/surface?format=glb|json` — кэшируемый immutable-меш; `GET /api/v1/brodmann/{ba}` — вершины конкретной области по запросу (а не все 280 960 индексов сразу).
4. Pydantic-схемы ответов → генерация TypeScript-типов из OpenAPI (единый контракт UI ↔ backend).
5. В ответе анализа: эпохи с флагами (`has_artifact`, причины), `drop_log`, `frequency_powers`, `best_fit_dipoles`; траектория — отдельным лёгким или бинарным запросом.
6. Провенанс и версия схемы (`GET /api/v1/meta`), чтобы UI мог показать, чем и с какими параметрами посчитан результат.
7. CORS: 5173 (Vite) / 3000 (CRA) / 8000; при сборке UI в `backend/app/static` — same-origin режим без CORS.
8. Ограничение числа параллельных задач + понятные коды ошибок (413/422/429/500) для UX-сообщений.

### 7.6 Что нужно решить перед кодом UI

- Стек frontend: Vanilla JS + Three.js в `backend/app/static` (same-origin, без сборки) **или** отдельный `frontend/`
  на Vite + React + TypeScript + react-three-fiber (типы из OpenAPI, HMR, но +Node и CORS).
- Формат обмена 3D-данными: GLB/PLY (бинарный, компактный) против JSON (совместимо, но 3–10 МБ).
- Объём истории в UI: только текущая сессия или список сессий из БД (тогда read-API обязателен уже в P0).
- Профиль расчёта по умолчанию для UI: `fast` (превью, decim) или `accurate` (долго, но корректнее).

---

### 7.7 Находки живого прогона пайплайна (13.09.2026)

Прогон полного пайплайна на `data/edf/test.edf` (18 каналов, 500 Гц, 130.7 с) через job-API.
Фиксируются отдельно от §7.2: это дефекты **исполнения**, которые не видит быстрый набор тестов.

| # | Уровень | Находка | Что делать |
|---|---|---|---|
| F17 | 🔴 | `mne.fit_dipole` в MNE 1.13.2 возвращает **кортеж** `(dipoles, residual)` (проверено: `type(out).__name__ == 'tuple'`, исходник MNE заканчивается `return dipoles, residual`). В `dipole_fitter.fit_dipoles_for_epochs` результат используется как `mne.Dipole` → на каждой эпохе `AttributeError: 'tuple' object has no attribute 'pos'` → **диполей нет вообще**, `best_fit_dipoles: []` | Распаковать `dip, _ = mne.fit_dipole(...)`; закрыть контракт тестом |
| F18 | 🔴 | Ошибки фитинга проглатываются поштучно (`except Exception` → `{"error": ...}`), поэтому задача получает статус `succeeded` и «прогресс 1.0» при нулевом результате: UI покажет «успех» без диполей | Агрегат ошибок в контракте (`n_dipole_errors`, тексты) + предупреждение в UI; задача с 100 % ошибок не должна выглядеть успешной |
| F19 | 🔴 | Стоимость не проверяется ничем: `mne.fit_dipole` — **5.4 с на одну временную точку** (замер), `Dipole.to_volume_labels` — **0.25–0.36 с на точку** (том `aparc.a2009s+aseg` перечитывается каждый вызов, кэша нет), `head_to_mni` — 0.006 с. Дефолты (65 эпох × 200 точек при `decim=5`) дают ≈ **20 ч** расчёта: реальный прогон шёл 66 минут и оставался на этапе `dipoles`/0.90, а прогресс внутри этапа не дробится (UI выглядит зависшим) | Фаза 3 (кнопка «Рассчитать диполи»): оценка времени до запуска, режим превью, `n_jobs`, кэш BEM-объекта, кэш aseg-тома, дробный прогресс по эпохам/точкам, профили `fast`/`accurate` (F11) |
| F20 | 🟡 | Детектор flat-line даёт ложные срабатывания: критерий `|x| < 5 мкВ` дольше 200 мс при band-passed сигнале (std по каналам 4.8–11.3 мкВ, диапазон ±80 мкВ) — под порог попадает 36–72 % отсчётов, отсюда **222 из 290** артефактов | Критерий «почти константа»: оконный peak-to-peak (или разброс) в скользящем окне, а не абсолютная амплитуда; тесты на синтетике (константный участок против полосового шума). Важно для Фазы 2 (зоны артефактов) |
| F21 | 🟡 | После успешной задачи в БД `epochs=0`, `dipoles=0` (записывается только `sessions`) — F5 в действии: эпохи не сохраняются вовсе, `epoch_id` по-прежнему ссылается на `epoch_index` | Либо реализовать запись эпох/FK в рамках read-API (Фаза 4/5), либо явно задокументировать как ограничение |

**Проверено этим же прогоном и работает:** job-API (202 → поллинг → результат), этапы и подписи,
очистка временной загрузки в `finally`, дамп `results/{session_id}.json`, provenance-блок `pipeline`,
кэш surface (728 КБ, ETag/304), `/api/v1/brodmann-labels` (82 области), раздача `/ui/` и `/legacy`.

**Мелочь (документация):** команды вида `curl :8000/health` из `README.md`/`AGENTS.md` в окружении
с современным curl не работают (нужна схема) — заменить на `curl http://localhost:8000/health`.

---

*Итог повторного аудита (13.09.2026): пайплайн работоспособен и покрыт быстрыми тестами; блокирующих
дефектов для старта UI нет, критичные для UI находки F4, F6, F7, F14 закрыты в Фазе 0. Живой прогон
(§7.7) показал, что **дипольная ветка не работает** (F17/F18) и что её стоимость на дефолтах —
десятки часов (F19): это задачи Фазы 3, до подключения кнопки «Рассчитать диполи» они пользователя
не касаются, потому что UI ничего не считает автоматически.*
