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