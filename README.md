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
│   │   │                      # + assets.py (ETag/304), params.py (формы), recording_jobs.py (задачи), uploads.py
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
│   │   │   ├── cache_store.py       # единый дисковый кэш: путь, чтение, атомарная запись, очистка
│   │   │   ├── prepared_signal.py   # RAM-кэш подготовленного сигнала (EDF один раз на набор параметров)
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
├── docs/                      # документация
│   ├── ui.md + ui/            # спецификация UI (индекс и разделы §) + ui/roadmap.md
│   ├── rules/                 # правила по темам: вьюер, диполи, ЭЭГ, API, фронт, данные, безопасность
│   ├── data_map.md            # карта данных: кэши, файлы, БД, localStorage, формат журнала шагов
│   └── history.md             # журнал закрытых работ (закрытое из todo.md)
├── data/                      # локальные данные
│   ├── edf/                   # test.edf в репо + каталоги записей сессий (копии не плодятся)
│   ├── results/               # результаты анализа (игнорируются)
│   └── cache/                 # кэш меша/BA (игнорируется, пересчитывается)
├── AGENTS.md / audit-2026-09.md / audit.md / todo.md
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
npm run build:watch # автосборка туда же при правках: :8000/ui/ не отдаёт устаревший бандл
```

Разделы: **Главная**, **EDF** (просмотр записи и подготовка эпох), **Диполи** (3 проекции с реальным
срезом МРТ и контурами атласа, быстрый расчёт диполей, воспроизведение траектории и спектр δ…γ),
**Таблица локализации** (все точки результата, включая структуру и поле Бродмана),
**Групповой анализ**; внизу рейла — **Настройки** и **Состояние сервера**
(туда перенесена информация о готовности компонентов, ранее отображавшаяся на стартовой странице).
Legacy-страница с прогрессом инициализации осталась доступна по `/legacy`.
Статус фаз, принципы интерфейса и план работ — `docs/ui.md`.

## Консилиум: ручное исследование (Т1)

Раздел доступен по `http://localhost:8000/ui/consilium` после сборки фронтенда
и обновления процесса backend. В dev: `http://localhost:5173/ui/consilium`.

1. Создайте исследование: вопрос, название и обезличенный код добровольца.
2. Свяжите зарегистрированные EDF-записи в паспорте; добавьте рассказ и наблюдения.
3. Во вкладке «Материалы и досье» примите конкретные результаты задач, сессий,
   пакета диполей, сравнения пары или группы. Сами расчёты эта кнопка не запускает.
4. Выберите материалы/контекст и опубликуйте снимок. Последующие исправления
   и новые прогоны не меняют прошлое досье; основания раскрываются по запросу.
5. Архивирование сохраняет данные. Удаление требует предпросмотра; исходные
   EDF/расчёты при удалении дела не затрагиваются.

**Это основание без ИИ и аудио:** советники и стенография появятся отдельными
этапами. Старые результаты не дают общего паспорта подготовки/единиц, пробелы
обозначаются; спектрограмма пока принимается только метаданными без DPS2-сетки.
Группа фиксируется по текущим пакетам на момент добавления, не по числам при
первоначальном сохранении определения группы.

Перед первым использованием нового API сделайте резервную копию БД: `init_db`
поднимет схему до `0007`. Для SQLite используйте backup API или остановите сервер
перед копированием; новые материалы хранятся в основной БД, не в кэшах.
Правила и ограничения — `docs/rules/consilium.md`, этапы —
`docs/strategy/05-consilium.md`.

## 🖥 Запуск с рабочего стола (единый лаунчер)

```bash
./start.sh            # поднять сервер (или только открыть UI, если уже поднят)
./start.sh status     # жив ли процесс и /health
./start.sh stop       # остановить сервер по PID-файлу

bash desktop/install-desktop.sh          # ярлык «DipLock» в меню приложений (+иконка)
bash desktop/install-desktop.sh remove   # удалить ярлык
```

Лаунчер стартует `uvicorn` из `backend/venv` на `127.0.0.1:8000` (без `--reload`),
ждёт `/health` и открывает `http://localhost:8000/ui/` в браузере. Лог и PID —
`data/logs/server.log` / `server.pid`. Работает только собранная версия UI
(`cd frontend && npm run build`); sudo не нужно — ярлык ставится в `~/.local/share`.

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

## 🎵 VAMP-анализ (Sonic Annotator) — установка

Для **вращения звезды «Эмо» по тональности** микса используется
**Sonic Annotator** (C4DM QMUL) с плагином **QM Key Detector** из
Vamp Plugin Pack. Инструмент **опциональный**: без него рендер и кадры
«Эмо» работают как прежде (`key_track: null`, вращение нулевое).

```bash
# 1. Бинарь Sonic Annotator 1.7 (linux64-static) → tools/sonic-annotator/
#    https://github.com/sonic-visualiser/sonic-annotator/releases
mkdir -p tools/sonic-annotator && cd tools/sonic-annotator
curl -L -o sa.tar.gz \
  https://github.com/sonic-visualiser/sonic-annotator/releases/download/sonic-annotator-1.7/sonic-annotator-1.7.0-linux64-static.tar.gz
tar xzf sa.tar.gz --strip-components=1 && rm sa.tar.gz
cd ../..

# 2. Vamp Plugin Pack (Linux x86_64) → ~/vamp
#    https://www.vamp-plugins.org/download.html
#    Инсталлятор спрашивает выбор каталога и подтверждения — принимайте
#    установку плагинов в $HOME/vamp (стандартный пользовательский путь
#    VAMP под Linux). Либо вручную: распаковать архив пакета и скопировать
#    *.so, *.n3, *.cat в ~/vamp.

# 3. Проверка цепочки
VAMP_PATH=$HOME/vamp tools/sonic-annotator/sonic-annotator -l | grep keydetector
# → vamp:qm-vamp-plugins:qm-keydetector:key
```

**Нюансы установки:**

- **FUSE**: бинарь — AppImage-сборка; на системах без FUSE установите
  `sudo apt install libfuse2` (Ubuntu 22.04/24.04), иначе запуск падает с
  «Cannot mount AppImage».
- **Ловушка `VAMP_PATH`** (случай 09.10.2026): дефолтный поиск плагинов
  статической сборки 1.7 падает с «buffer overflow detected» — бэкенд
  **всегда** передаёт `VAMP_PATH` явно; при ручном запуске делайте так же.
- **Пути** настраиваются в `.env`: `SONIC_ANNOTATOR_BIN` (дефолт
  `tools/sonic-annotator/sonic-annotator`) и `VAMP_PATH` (дефолт `~/vamp`).
- **Docker**: в образ инструмент не входит — ставьте внутрь контейнера
  по шагам выше либо монтируйте `tools/` и `~/vamp` томами.
- Transform плагина зафиксирован в репо:
  `backend/vamp/transforms/qm-keydetector-key.n3` (step/block 32768,
  length 10, tuning 440). Лицензия инструмента — GPL-2.0 (запускается
  отдельным процессом, код проекта не смешивается). Подробности —
  `docs/rules/neuromusic.md`, §«Вращение звезды».

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
   MNI x/y/z, полушарие, структура атласа, амплитуда, GOF, поле Бродмана), сортировка по эпохе и
   состав колонок без единого запроса к серверу, предупреждение «параметры изменены — результат не
   пересчитан». Дорожная карта дальше (фильтры, поиск, виртуализация, экспорт, сохранение в БД) —
   `docs/ui/table.md` (§3.4) и `docs/ui/roadmap.md` (§10)
14. **Фаза 3, срезы 3.5–3.7 (15–16.09.2026):** раздельные слои позиций и векторов диполей с выделением
   по клику, форма фильтров расчёта (пресеты δ…γ из `/meta`, своя полоса, одиночная частота
   `f ± bw/2`, «без фильтра» + сетевой 50/60 Гц), **воспроизведение траектории**: кадр по сетке эпох
   (×1/×2/×4), интерполяция позиции и направления момента между соседними эпохами, покадровый шаг,
   затухающий шлейф, `Space`
15. **Фаза 3, срезы 3.8–3.9 (16.09.2026):** **анатомия на срезах** — векторные контуры `aparc+aseg`
   (структуры) и производной объёмной разметки полей Бродмана (`ribbon` × `PALS_B12_Brodmann`,
   ближайшая вершина коры) с ETag/304, слои «Анатомические структуры» и «Поля Бродмана», клик по
   полигону называет структуру и поле; затем поправки ручной проверки: справка **диалогом** из
   тулс-хедера (рабочая область без пояснительного абзаца), анимация **отдельным слоем**,
   кольца позиций Ø 6 px и колонка «Структура» в таблице (метка `aparc+aseg` по MNI от сервера)
