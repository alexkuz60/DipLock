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
│   ├── preprocess.py      # стадии предподготовки записи: filter/artifacts/epochs (2.7)
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
санитизацию загрузок, сигналы записи (формат `DPS1`, ETag/304, уровни, кэш), стадии предподготовки
(`POST /recordings/{id}/preprocess`: 202 + задача, `result_url`, 400/404, зоны с каналами, отброшенные
эпохи), config, bandpass_filter,
epoch_segmenter, montage edf_loader; на UI — каркас
(рейл, тулс-хедер, панели, хоткеи), реестр разделов, «Главная», «Настройки», «Состояние сервера»,
HTTP-клиент и разбор ошибок, контролы правой панели, параметры раздела EDF, загрузка записи
(`EdfSection`), вьюер треков (`viewer/TrackStack` — с моком uPlot, математика окна/огибающей в
`viewerMath.test.ts`, разбор контейнера сигналов в `signalFrame.test.ts`, энкодер для тестов —
`test/signalBlob.ts`) и тулс-хедер раздела (`EdfToolActions` +
`EdfRecalcButtons`, диалог паспорта `SessionPassportDialog`, стор записи `edfRecording.test.ts`),
экспорт окна (`exportWindow.test.ts` — CSV/имя файла/шкала/геометрия снапшота, `download.test.ts` —
ссылка и кодирование canvas, `viewer/ExportActions` — кнопки, содержимое файлов, ошибка PNG;
срез 2.9 добавил тесты ревизии: паспорт и «Закрыть запись» в шапке, листание окна кнопками
`<<` `<` `>` `>>`, курсор по клику, разворот трека по названию канала и сброс разворота при скрытии
канала; срез 2.10 — скролл каркаса (классы grid в `AppShell.test.tsx`), разметку эпох по длине
нарезки результата, Ctrl+двойной клик по треку (блокировка/снятие блокировки эпохи) и чистую
арифметику пометок в `viewerLayers.test.ts`; срез 2.11 — курсор и карточка зоны внутри
прокручиваемого контента (`sticky`), счётчик пометок по правкам, а не по ячейкам сетки
(`TrackStack.test.tsx`); срез 3.1 — проекции мозга (`dipoles/MriProjection.test.tsx`: слои,
подписи краёв по знакам осей, сетка MNI и следы соседних срезов, клик → точка MNI в плоскости
среза и поле Бродмана, наведение; `dipoles/DipolesSection.test.tsx`: три проекции, наведение
срезов кликом, ноль запросов к серверу; `dipoles/DipolesPanel.test.tsx`: слои, линейки срезов,
сбросы); геометрия проекций, слой диполей и состояние раздела (`mriProjections.test.ts`,
`dipolePoints.test.ts`, `state/dipoleParams.test.ts`)). Всего 267 тестов Vitest.
**Правило:** новый сервис/багфикс → тест (backend → pytest, frontend → Vitest).

## Живой вьюер: интерактив (срез 2.9), разметка (2.10) и оверлеи (2.11)

- Команды из шапки (листание окна `<<` `<` `>` `>>`) идут во вьюер **только через состояние** —
  `navRequest` `{command, seq}` в `shared/state/edfRecording.ts`; `seq` монотонно растёт, поэтому
  повторный рендер и повторное монтирование вьюера не проигрывают старую команду
  (`handledNavSeqRef` инициализируется текущим `seq`). Императивных «ручек»/событий у вьюера нет.
- Параметры отрисовки, которые не должны переживать выход из раздела или обесценивать стадии, живут
  **в локальном состоянии** `TrackStack`: центр окна, курсор и разворот трека. В zustand — только то,
  что переживает перезаход (уровень зума, каналы, шкала амплитуды, видимость слоёв).
- **Каркас держит высоту окна**: `AppShell` — grid со строкой `grid-rows-[minmax(0,1fr)]`, колонка
  рабочей области — `min-h-0`. Без явной строки неявная растягивалась под содержимое: треки уходили
  за экран, резались `overflow-hidden` и внутренние скроллы (треки/панель) не появлялись вовсе.
  Правите каркас — проверяйте скролл в браузере, а не только тестами jsdom (там нет раскладки).
- Курсор ставится **кликом** и живёт до следующего клика (мышь его не таскает): `handleTrackClick`
  игнорирует клики после drag (`draggedRef`, порог dx > 3 px) и клики по кнопкам
  (`closest('button')` — подписи каналов и зоны артефактов).
- **Оверлеи вьюера — внутри прокручиваемого контента** (`data-testid="viewer-content"`), а не
  детьми скролл-контейнера (срез 2.11): абсолютный потомок скролл-контейнера скроллится вместе с
  содержимым, поэтому линия курсора `inset-y-0` имела высоту видимой области и при прокрутке вниз
  обрывалась на середине стека. Линия курсора тянется на весь стек, а подпись времени и карточка
  выделенной зоны «липнут» к верху области через `position: sticky` в контейнере `absolute inset-0`
  (его высота = высота всего контента — sticky работает до конца прокрутки). Новые оверлеи делайте
  так же; проверяйте прокруткой в браузере, jsdom раскладку не считает.
- **Ширина полосы прокрутки** (срез 2.11): `.scroll-y-always` задаёт её только через
  `::-webkit-scrollbar` (20 px вместо «тонких» 10 px — узкую полосу трудно хватать мышью). Стандартные
  `scrollbar-width`/`scrollbar-color` (Chrome 121+) отключают legacy-псевдоэлементы, поэтому для
  Firefox они вынесены в `@supports (-moz-appearance: none)`. Не возвращайте `scrollbar-width: thin`.
- Клик по названию канала разворачивает трек на высоту видимой области (`ResizeObserver`,
  фолбэк `TRACK_HEIGHT` при `viewportHeight === 0` в jsdom); соседи уезжают в скролл, стадии не
  сбрасываются. Скрытие канала в панели сбрасывает разворот. **mute/solo выпилены** — видимость
  каналов задаётся только чекбоксами панели.
- Неотключаемый вертикальный скроллбар — утилита `.scroll-y-always` в `styles/index.css`
  (`overflow-y: scroll` + `scrollbar-gutter: stable`), применена в треках и
  панели опций: полоса не «дёргается» между разделами. Не заменяйте её на `overflow-y-auto`.
- **Разметка эпох привязана к своей нарезке** (срез 2.10): у слоя-результата сетка строится по
  `epoch_length_ms` этого результата (`gridEpochLength`), у фикстуры/до расчёта — по параметру панели.
  Раскладывать `rejected_epochs` по текущему параметру нельзя: индекс живёт только внутри своей
  нарезки, и после смены длины эпохи штриховка уезжала на другой участок записи. Расхождение длин
  показывается пилюлей «разметка эпох: N мс» (стадия при этом помечена stale).
- **Ручные пометки эпох** (Ctrl+двойной клик по треку, `handleTrackDoubleClick`) хранятся
  **интервалами на таймлайне** (`EpochMark` в `shared/lib/viewerLayers.ts`), а не индексами, и живут
  в сторе записи (`edfRecording.epochMarks` — не в localStorage: правка относится к конкретной
  сессии). `toggleEpochMark` инвертирует итоговый вердикт эпохи и хранит правку только когда она
  расходится с решением алгоритма; правка видна и при выключенной штриховке, а снять её можно
  кнопкой «Снять» в панели «Эпохи». Счётчик «ручных пометок: N» считает **пометки**
  (`epochMarks.length`), а не ячейки сетки: после смены длины эпохи одна правка накрывает несколько
  эпох новой нарезки, а их штриховки сливаются в одну видимую полосу — счёт по ячейкам показывал бы
  «6» там, где пользователь поставил три (панель «Эпохи» считает так же). В расчёт диполей пометки
  пока не уходят (см. docs/ui.md §12).

## Проекции мозга: раздел «Диполи» (срез 3.1)

- Проекции рисуются **SVG, а не canvas**: цвета берутся токенами темы прямо в атрибутах
  (`stroke="var(--color-mri-dipole)"`, токены `--color-mri-*`). Canvas — только под пиксельную
  заливку реального тома МРТ (`docs/ui.md` §3.3), когда она появится.
- Геометрия — одна на все проекции (`shared/lib/mriProjections.ts`): оси масштабируются
  независимо, `x = 0` — срединная сагитталь, `y = 0`/`z = 0` — через AC–PC. Клик по фигуре даёт точку
  **в плоскости своего среза** (`pointFromProjectionClick`), клик наводит все три среза
  (`applyPointToSlices` + `snapSlice`). Не дублируйте математику в компонентах и не заводите второй
  «невидимый» слой для мыши: попадание в поле Бродмана считается по тем же эллипсам, что нарисованы
  (`brodmannAreaAt`).
- Слои `head`/`mni`/`brodmann`/`dipoles` включаются чекбоксами панели; выключенный слой **не
  рисуется**, а не прячется прозрачностью. Порядок и подписи — в `shared/state/dipoleParams.ts`,
  отрисовка — `sections/dipoles/MriProjection.tsx`, сборка трёх фигур — `DipolesSection.tsx`.
- Срез наводится кликом (на глаз, с прилипанием к именованным) и `SliceScrubber` в панели (точно, с
  маркерами `x = 0`). «Точка под курсором» — локальное состояние проекции, в стор уходят слои, срезы,
  референс-точка и выделенное поле.
- Слой диполей — **пустой по замыслу**: раздел не имитирует расчёт, панель пишет «расчёт не
  подключён». Тип `DipolePoint` (MNI, момент, амплитуда, GOF, BA), векторы и хит-тесты уже есть —
  подключение расчёта станет сменой источника данных. Фикстура `demoDipoleLayer` — только для тестов
  и отладки отрисовки.
- Фикстуры слоёв (`demoHeadContours`, `demoSliceStructures`, `demoBrodmannAreas`) детерминированы
  (без ГПСЧ): картинка одинакова между рендерами, тестами и повторным монтированием. Реальный контур
  даст fsaverage, реальные поля — `PALS_B12_Brodmann` (`surface_cache.py`).

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
- Слои результата вьюера (срез 2.6) — DOM поверх canvas-треков, а не часть uPlot: зоны артефактов,
  границы эпох, штриховка отброшенных. Контракт типов и цветов живёт в `frontend/src/shared/lib/artifacts.ts`
  (реэкспорт из `shared/state/edfParams.ts`), геометрия/фикстура — в `shared/lib/viewerLayers.ts`,
  отрисовка — в `app/sections/viewer/TrackLayers.tsx`. Цвета — токены темы (`--color-artifact-*`),
  заливка через `color-mix`, hex в JS не дублируется. До запуска стадии слои берутся из
  детерминированной фикстуры `demoLayers` с `source: 'demo'` (UI не имитирует обработку), после —
  из результата задачи (`source: 'result'`, срез 2.7), причём слоты стадий не перетирают друг друга.
  Слои и курсор делят одну систему координат с canvas-треками через `timeToX`/`xToTime`
  в `shared/lib/viewerMath.ts`.
- Предподготовка записи (2.7): стадия = задача (`kind=preprocess`) через общий `job_manager`, файл
  записи не удаляется. Контракт `PreprocessResult` (`backend/app/schemas/analysis.py`) отдаётся
  `app/services/preprocess.py`; `filter`/`artifacts`/`epochs` считаются на **свежем** сигнале (параметры
  фильтра уходят в запрос любой стадии), снимок параметров фиксируется в момент запуска кнопки
  (`stageSignature` + `markStageApplied(stage, signature)`), ошибка стадии показывается текстом.
  Детектор артефактов возвращает `zones` с каналами — аннотации MNE их не хранят. Пирамида сигналов
  пока «сырая»: перевод её на отфильтрованный сигнал — отдельный срез, а не тихая подмена данных.
- Экспорт окна (2.8) — **клиентский, без запросов**: данные уже в браузере, сервер не пересчитывает
  экран. Чистые модули `shared/lib/exportWindow.ts` (CSV, имя файла, деления шкалы, раскладка и сборка
  снапшота) и `shared/lib/download.ts` (Blob → ссылка → скачивание); кнопки — `viewer/ExportActions.tsx`
  в полосе вьюера, т.к. им нужны окно/каналы/canvas'ы треков (регистрируются в `TrackStack` через
  `canvasesRef`/`registerCanvas` — ref, а не состояние). CSV — длинный формат
  `time_sec,channel,min_uv,max_uv` (строка на пару «корзина × канал»): кадр уровня ×k прорежен
  сервером, выдавать его за полноразрешённый сигнал нельзя. PNG склеивается из canvas'ов uPlot плюс
  свои подписи/шкала/зоны/эпохи; canvas не читает CSS-токены — цвета через `getComputedStyle` с
  hex-fallback; отсутствие `toBlob` → текст ошибки, а не пустой файл.
