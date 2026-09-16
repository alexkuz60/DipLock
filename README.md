# 🧠 DipLock — Анализ ЭЭГ + токовые диполи в 3D

## 📋 Требования (финальные)

| № | Требование | Примечание |
|---|-----------|------------|
| 1 | Вход: **EDF** | Только EDF |
| 2 | Эпохи: **без overlap**, длина выбирается из `[250, 500, 750, 1000, 1250, 1500, 1750, 2000]` мс | Максимум 2000 мс |
| 3 | Авто-детекция артефактов | z-score, порог 100 µV, ICA EOG/EMG, flat-line |
| 4 | Условная модель мозга | FSAverage (шаблон FreeSurfer) |
| 5 | Частотная фильтрация | δ/θ/α/β/γ + **кастомный диапазон** + **одиночная частота** (например, 7.83 Гц, bw=0.5 Гц) |
| 6 | Анимация диполей | trajectory по времени → Three.js |
| 7 | База данных | PostgreSQL для группового анализа |
| 8 | Локализация | Анатомия (FreeSurfer aparc) + Brodmann Area (BA1–BA48) |
| 9 | 3 проекции | Top (axial) / Side (sagittal L/R) / Front (coronal) |

---

## 🚀 Структура проекта

```
DipLock/
├── backend/
│   ├── app/
│   │   ├── main.py            # FastAPI entry: CORS, gzip, /ui (сборка frontend), /init-status
│   │   ├── core/config.py     # Pydantic Settings — единый источник конфигурации
│   │   ├── api/routes.py      # /analyze, /jobs, /recordings (+/signals, /preprocess, /dipoles, /spectrum), /surface, /meta
│   │   ├── schemas/analysis.py# Pydantic-контракт ответов (→ TypeScript-типы UI)
│   │   ├── services/
│   │   │   ├── edf_loader.py
│   │   │   ├── artifact_detector.py
│   │   │   ├── epoch_segmenter.py
│   │   │   ├── bandpass_filter.py
│   │   │   ├── dipole_fitter.py     # точный фитинг: mne.fit_dipole по эпохам (медленно)
│   │   │   ├── dipole_scanner.py    # быстрый расчёт: перебор узлов сетки, сферическая модель
│   │   │   ├── spectral.py          # спектр δ…γ (Welch) + топокарты PNG (кэш, ETag/304)
│   │   │   ├── preprocess.py        # стадии предподготовки записи: filter/artifacts/epochs
│   │   │   ├── recordings.py        # реестр записей просмотра: паспорт, TTL
│   │   │   ├── recording_signals.py # пирамида сигналов вьюера (контейнер DPS1)
│   │   │   ├── mri_slices.py        # том T1 на MNI-сетке, срез картинкой PNG (ETag/304)
│   │   │   ├── atlas_contours.py   # контуры структур и полей Бродмана на срезе (вектор, ETag)
│   │   │   ├── job_manager.py     # фоновые задачи: этапы, прогресс, семафор
│   │   │   └── surface_cache.py   # кэш меша fsaverage и BA-меток (ETag/304)
│   │   ├── models/db.py
│   │   ├── utils/             # brain_export.py, versions.py, png.py (энкодер срезов),
│   │   │                      # marching_squares.py (изолинии маски)
│   │   └── static/
│   │       ├── index.html     # legacy-страница (доступна по /legacy)
│   │       └── ui/            # сборка frontend (npm run build) — раздаётся по /ui/
│   ├── tests/                 # pytest: контракт API, job-API, поверхность, сервисы
│   ├── requirements.txt / requirements-dev.txt
│   ├── Dockerfile
│   └── .env.example           # шаблон конфигурации (реальный .env не коммитится)
├── frontend/                  # UI: Vite + React + TypeScript + Tailwind
│   ├── src/app/               # каркас (layout) и разделы (sections)
│   ├── src/shared/            # api-клиент, zustand-стор, UI-примитивы
│   └── vite.config.ts         # base '/ui/', proxy на :8000, сборка в backend/app/static/ui
├── docs/
│   └── ui.md                  # функциональная спецификация UI и дорожная карта фаз
├── data/                      # локальные данные
│   ├── edf/                   # test.edf в репо + каталоги записей сессий (копии не плодятся)
│   ├── results/               # результаты анализа (игнорируются)
│   └── cache/                 # кэш меша/BA (игнорируется, пересчитывается)
├── AGENTS.md / audit.md / todo.md
└── docker-compose.yml / init_db.sql / setup.sh
```

---

## 🏃 Быстрый старт в VS Code

```bash
# Создаём структуру
bash setup.sh

# Python окружение
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Авто-скачивание FSAverage (один раз, ~500 МБ)
python -c "import mne; mne.datasets.fsaverage.data_path(download=True)"

# Старт сервера
uvicorn app.main:app --reload --port 8000
# → Swagger UI: http://localhost:8000/docs
# → UI (если собран): http://localhost:8000/ui/
```

## 🖥 Пользовательский интерфейс

```bash
# Режим разработки (HMR, прокси /api → :8000, CORS не нужен)
cd frontend
npm install
npm run dev        # → http://localhost:5173/ui/

# Проверки качества и продакшн-сборка
npm run typecheck  # tsc --noEmit
npm run lint       # ESLint
npm run test       # Vitest (jsdom)
npm run build      # → backend/app/static/ui, раздаётся FastAPI по /ui/
```

Разделы: **Главная**, **EDF** (просмотр записи и подготовка эпох), **Диполи** (3 проекции с реальным
срезом МРТ, быстрый расчёт диполей и спектр δ…γ), **Таблица локализации** (все точки результата),
**Групповой анализ**; внизу рейла — **Настройки** и **Состояние сервера**
(туда перенесена информация о готовности компонентов, ранее отображавшаяся на стартовой странице).
Legacy-страница с прогрессом инициализации осталась доступна по `/legacy`.
Статус фаз, принципы интерфейса и план работ — `docs/ui.md`.


---

## 🐳 Запуск через Docker Compose

```bash
docker-compose up --build
# → backend: http://localhost:8000
# → Swagger UI: http://localhost:8000/docs
# → PostgreSQL: localhost:5432
# → Redis: localhost:6379
```

---

## 📤 Пример API-запроса

Синхронный вариант (скрипты, curl):

```bash
curl -X POST "http://localhost:8000/api/v1/analyze" \
  -F "file=@/path/to/recording.edf" \
  -F "epoch_length_ms=500" \
  -F "freq_band=alpha" \
  -F "single_freq=7.83"
```

Асинхронный вариант — то, что использует UI (прогресс по этапам, результат переживает обрыв соединения):

```bash
JOB=$(curl -s -X POST "http://localhost:8000/api/v1/jobs" \
  -F "file=@/path/to/recording.edf" -F "epoch_length_ms=2000" \
  | python -c "import sys,json; print(json.load(sys.stdin)['job_id'])")
curl -s "http://localhost:8000/api/v1/jobs/$JOB"          # статус, этап, прогресс 0..1
curl -s "http://localhost:8000/api/v1/jobs/$JOB/result"   # результат по схеме AnalyzeResponse
```

**Ответ анализа:** `session_id`, метаданные записи, `n_epochs_total`/`n_epochs_used`/`n_epochs_dropped`,
`artifact_types`, `frequency_powers`, `dipoles` (траектория по времени + `best_fit` + локализация),
`best_fit_dipoles` (компактно, для таблицы), ссылка на кэшируемый меш `surface`
(`version`/`url`/`brodmann_url`) и блок `pipeline` (версии MNE/numpy/Python, пороги, `decim`,
время расчёта) — provenance результата.

**Статические 3D-ассеты** отдаются отдельно и кэшируются:
`GET /api/v1/surface` (меш, ETag/304) · `GET /api/v1/surface/brodmann` (индексы BA) ·
`GET /api/v1/surface/brodmann/{ba}` (одна область) · `GET /api/v1/brodmann-labels` (имена меток) ·
`GET /api/v1/surface/mri/slice/{plane}/{mm}.png` (срез МРТ, ETag/304) ·
`GET /api/v1/surface/contours/{plane}/{mm}` (контуры структур `aparc+aseg` и полей Бродмана
в мм MNI, ETag/304) · `GET /api/v1/surface/contours` (метаданные контуров) ·
`GET /api/v1/meta` (версии, пути, активные параметры).


---

## 🔧 Исправления по сравнению с исходным черновиком

1. `mne.read_labels_from_mgovt` → `mne.read_labels_from_annot` (атлас `PALS_B12_Brodmann`)
2. `brain_export.py` — `export_fsaverage_surface` корректно принимает `settings` параметром
3. `mne.vertex_map` (не существует) → поиск ближайшей метки BA через координаты вершин
4. Добавлен `trimesh` в `requirements.txt` (децимация surface-мешей)
5. `docker-compose.yml` — исправлен путь к `.env` (`./backend/.env`)
6. Добавлен `setup.sh` для создания структуры папок
7. **Фаза 0 (13.09.2026):** Pydantic-контракт ответов, кэш меша/BA (ETag/304, gzip), job-API
   с прогрессом, санитизация и очистка загрузок, `GET /api/v1/meta`, CORS для Vite (5173)
8. **Фаза 1 (13.09.2026):** UI-каркас (Vite + React + TypeScript) — рейл разделов, тулс-хедеры,
   схлопываемый правый сайдбар, Главная-заставка, «Настройки» и «Состояние сервера», тесты Vitest,
   сборка в `backend/app/static/ui`
9. **Фаза 2, срезы 2.0/2.1 (13.09.2026):** контролы правой панели (`FieldRow`, `SegmentedControl`,
   `SelectField`, `NumberField`, `CheckboxRow`, `StatusPill`) и параметры раздела EDF
   (`shared/state/edfParams.ts`: дефолты из `/meta`, выбор каналов, признак «результат устарел»).
   Правило: **обработка запускается только по кнопке** — правка параметров не делает ни одного
   запроса и ничего не пересчитывает.
10. **Фаза 2, срезы 2.2–2.9 (13–14.09.2026):** загрузка EDF (`POST /recordings`), вьюер треков на
   реальных сигналах (`GET /recordings/{id}/signals`, контейнер `DPS1`, пирамида ×1…×16), стадии
   предподготовки (`POST /recordings/{id}/preprocess` + слои зон/эпох), экспорт окна (PNG/CSV),
   ревизия раздела EDF: паспорт и «Закрыть запись» в шапке, листание окна, курсор по клику,
   разворот трека по названию канала. Детали — `docs/ui.md`, статус — `todo.md`
11. **Фаза 2, срезы 2.10/2.11 (14.09.2026):** окно вьюера в высоте экрана (появились внутренние
   скроллы треков и панели), разметка эпох по длине нарезки результата, ручные пометки эпох
   (Ctrl+двойной клик) и их снятие, оверлеи внутри прокручиваемого контента (линия курсора на весь
   стек, `sticky`-подписи), широкая полоса прокрутки
12. **Фаза 3, срезы 3.1–3.4 (14–15.09.2026):** раздел «Диполи» — три SVG-проекции с единым масштабом
   мм/пиксель, реальный срез МРТ (том fsaverage `T1`+`brainmask` на MNI-сетке, PNG с ETag/304),
   **быстрый расчёт диполей по кнопке** (`POST /recordings/{id}/dipoles`: одна точка на эпоху в пике
   GFP, перебор сетки 2–20 мм на сферической модели — 261 эпоха за 2.2 с при шаге 7 мм), спектр δ…γ
   (Welch PSD) с топокартами PNG и FFT-гистограммой в выдвижной панели, порог «КД ≥ X нАм» как
   параметр отображения. Быстрый режим помечен `method='fast_grid'` и **не выдаётся** за точный
   фитинг `mne.fit_dipole`
13. **Фаза 4 (15.09.2026):** «Таблица локализации» — все точки результата расчёта (эпоха, пик GFP,
   MNI x/y/z, полушарие, амплитуда, GOF, поле Бродмана), сортировка по эпохе и состав колонок без
   единого запроса к серверу, предупреждение «параметры изменены — результат не пересчитан».
   Дорожная карта дальше (фильтры, поиск, виртуализация, экспорт, сохранение в БД) — `docs/ui.md` §3.4
