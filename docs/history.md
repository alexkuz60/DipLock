# История работ DipLock

> Журнал выполненных работ: сюда переносится всё закрытое из `todo.md` (дословно),
> чтобы текущий список задач оставался коротким. Новые записи — сверху, датой среза.

## 17.09.2026 — этап 4: единый поллинг задач и пары запросов клиента (A10)

Закрытый пункт `todo.md` (перенесён дословно): **«Этап 4: `shared/lib/jobPolling.ts` вместо трёх
копий `waitForJob`; по одному методу клиента на пару job/result (A10)»**.

Что сделано:

- **`shared/lib/jobPolling.ts` — один поллинг на весь UI.** `waitForJob(jobId, isCurrent, onTick)`
  опрашивает `GET /jobs/{id}` до `succeeded`, отдавая каждый опрос в `onTick`; ошибка задачи —
  `JobFailedError` с текстом сервера, устаревший запуск — `JobCancelledError` (+ `isCancelled`).
  Пауза между опросами (`JOB_POLL_MS = 400`) общая, а не своя у каждого раздела.
- **Один механизм отмены вместо трёх токенов.** `createRunToken()` отдаёт `next()` (новая попытка:
  новый расчёт, новая стадия), `cancel()` (сброс раздела, «Закрыть запись») и `isCurrent(token)`.
  В сторах исчезли `let stageRunToken = 0` / `let calcRunToken: number | undefined` /
  `let eegRunToken` и ручные сравнения `token !== ...` в четырёх местах на файл, а также две копии
  `isCancelled` и три копии `waitForJob`. Поведение прежнее: устаревший ответ не трогает состояние
  и не показывается ошибкой.
- **Клиент: пара методов на задачу вместо двух с дублированным URL.** `RecordingJob<TResult>` +
  фабрика `recordingJob(kind)` в `shared/api/client.ts`; восемь методов (`preprocessJob`/
  `preprocessResult`, `spectrumJob`/`spectrumResult`, `dipoleScanJob`/`dipoleScanResult`,
  `spectrogramJob`/`spectrogramResult`) свёрнуты в четыре пары `api.preprocess`, `api.spectrum`,
  `api.dipoles`, `api.spectrogram` (`start` + `result`). Адреса на проводе не менялись — тест-двойник
  `test/apiMocks.ts` и существующие тесты прошли без правок.
- **Тесты:** `shared/lib/jobPolling.test.ts` (6: опрос до `succeeded` с прогрессом, пауза
  `JOB_POLL_MS` на фейковых таймерах, текст ошибки сервера и подстановка без текста, отмена закрывает
  цикл без лишних запросов, семантика `createRunToken`), `state/dipoleCalc.test.ts` (+1: «Сбросить
  расчёт» прекращает опрос — отложенный ответ задачи не возвращает результат),
  `state/edfRecording.test.ts` (+1: «Закрыть запись» отменяет поллинг стадии); помощник отложенных
  ответов — `test/deferred.ts`. 551 → **559** тестов Vitest (48 → 49 файлов); `npm run typecheck`,
  `npm run lint` — чисто.
- **Документация:** `docs/rules/frontend-state.md` (правило 7 «ожидание задачи — одно на весь UI»,
  раздел долга переписан: поллинг и пары клиента закрыты, остаток — `CalcJob`/отпечатки расчёта в
  сторе «Диполей» и осознанно разные конструкторы состояния задачи у разделов), `docs/rules/api-jobs.md`
  (правило 2), `docs/rules/tests.md`, `frontend/README.md`, `AGENTS.md` (15,1 КБ), `todo.md`,
  `audit-2026-09.md` (A10 закрыта, §5 этап 4).

## 17.09.2026 — этап 3: тонкие роуты и единый ETag/304 (A1 + A2)

Закрытый пункт `todo.md` (перенесён дословно): **«Этап 3: единый ETag/304 (`_asset_response`
вместо 5 ручных копий, A2) + выделение сервисов из `routes.py` (1438 строк, A1)»**.

Что сделано:

- **A2 — `app/api/assets.py`.** Один помощник `asset_response(data, version, *, if_none_match,
  media_type, cache_control, headers)` обслуживает **все восемь** мест отдачи ассетов: пирамида
  сигналов, топокарта диапазона, сетка спектрограммы, срез МРТ, контуры среза, `/surface`,
  `/surface/brodmann`, `/brain-surface` (было: 5 ручных копий + 3 вызова прежнего помощника).
  Заголовки кэша — именованные константы (`CACHE_PUBLIC_WEEK` / `CACHE_PUBLIC_DAY` /
  `CACHE_PRIVATE_DAY` / `CACHE_PRIVATE_HOUR`), значения на проводе не менялись. Условие 304:
  сравнение `If-None-Match` по списку тегов с нормализацией (`W/"v1"`, `v1`, `"v1"` — одно и то
  же, `*` → 304) вместо подстроки — старая проверка считала `"v1"` совпавшим в `"v10"`.
- **A1 — выделение из `routes.py`** (1438 → **875 строк**, обработчики по 5–15 строк):
  - `app/api/uploads.py` — приём EDF (`safe_edf_name`, `save_upload`, `MAX_UPLOAD_SIZE`) (F10);
  - `app/api/params.py` — формы → параметры сервисов и проверки с текстом для UI
    (`parse_filter_band`, `parse_reference_channels`, `require_epoch_length`,
    `validate_analysis_request`, `preprocess_params`, `spectrum_params`, `spectrogram_params`,
    `stored_spectrogram_params`, `dipole_scan_params`);
  - `app/api/recording_jobs.py` — задачи записи: `require_recording`, воркеры `WORKERS`,
    `submit_recording_job` (202 + `result_url` рядом с записью), `job_status`,
    `recording_job_result`, `job_by_id`;
  - `app/services/analysis_pipeline.py` — пайплайн файлового анализа (`/analyze`, `/jobs`),
    запись в БД и удаление временной загрузки; `noop_progress` переехал в `job_manager`;
    `surface_ref` — в `surface_cache`.
  Поведение API сохранено: те же роуты, те же коды и тексты ошибок, тот же состав заголовков
  (проверено тестами контракта). Патч-таргеты тестов переехали вместе с кодом
  (`analysis_pipeline.run_analysis` / `save_analysis_to_db`, `uploads.MAX_UPLOAD_SIZE`).
- **Найдено при переносе (A11, не исправлено осознанно):** сетка `grid.bin` собирает параметры
  пересчёта из результата задачи, а `reference` в результат не пишется — при
  `reference != 'average'` сетка пересчитывается с другим референсом, чем показывал расчёт.
  Ранее это молчаливое расхождение выглядело как часть контракта `grid.bin`; теперь оно
  задокументировано в `stored_spectrogram_params` и внесено в `audit-2026-09.md` (A11).
- **Тесты:** `tests/test_api_assets.py` (19), `tests/test_api_params.py` (25),
  `tests/test_api_recording_jobs.py` (14) → 214 → **270** pytest (263 без integration);
  инвентарь — `docs/rules/tests.md`. В `test_api_assets.py` — «сторож»: `status_code=304`
  не должен появляться вне `api/assets.py`.
- **Документация:** `AGENTS.md` (структура `api/*`, две новые конвенции), `README.md`,
  `docs/rules/api-jobs.md` (где что лежит, правила 2 и 4), `docs/rules/dipoles.md`,
  `docs/rules/eeg.md`, `docs/rules/safety.md`, `docs/data_map.md` (§8 и §10 п.3 закрыт),
  `docs/rules/tests.md`, `todo.md`, `audit-2026-09.md` (A1/A2 закрыты, A11 добавлена).

## 17.09.2026 — этап 2: единый кэш и кэш подготовленного сигнала (A3 + A4)

Закрытый пункт `todo.md` (перенесён дословно): **«Этап 2: кэш подготовленного сигнала (A4) +
единый модуль кэширования вместо дублей `_read_cached`/`_write_cached`/`clear_*_cache` (A3)»**.

Что сделано:

- **A3 — `services/cache_store.py`** (`cache_path` / `cache_read` / `cache_write` / `cache_clear`).
  Сведены **шесть** копий атомарной записи — не три, как в аудите: `surface_cache` (меш/BA),
  `recording_signals` (пирамида), `spectral` (топокарты), `spectrogram` (сетки), `mri_slices` (том),
  `atlas_contours` (объёмы меток). `cache_write` публикует файл через `os.replace`, при сбое логирует,
  возвращает `False` и убирает временный файл; `cache_clear` **требует** часть пути (защита от «снести
  весь `data/cache` опечаткой»). Осознанное исключение — сайдкар записи (`write_sidecar`): не кэш, а
  носитель дедупа.
- **A4 — `services/prepared_signal.py`.** RAM-LRU «(recording_id, единицы, каналы, референс, полоса,
  notch) → готовый `raw`»: `preprocess`, `spectral`, `spectrogram`, `dipole_scanner` берут сигнал
  только через `prepared_raw`. Мимо кэша осознанно: legacy `/analyze` (у него нет `recording_id`) и
  потоковое чтение пирамиды сигналов (`recording_signals`). Наружу отдаётся `raw.copy()` —
  `segment_epochs` мутирует аннотации на полученном сигнале. Размер — `PREPARED_SIGNAL_CACHE_SIZE`
  (по умолчанию 2 набора, 0 — выключить); вытеснение записи чистит кэш (`_drop_signal_cache`).
- **Замеры (живая машина, 17.09.2026).** `data/edf/test.edf` (130.7 с, 500 Гц, 18 кан.): промах
  `prepared_raw` 59 мс → попадание 1 мс; стадия `filter` предподготовки 56 мс → 1 мс. Синтетическая
  запись 20 мин (21.6 МБ, 18 кан., 500 Гц): первая полоса 863 мс, другая полоса 394 мс → попадание
  12 мс. Цена памяти одного набора — 9.4 МБ на `test.edf` и 86.4 МБ на 20-минутной записи (float64),
  отсюда лимит по умолчанию 2, а не «сколько влезет».
- **Тесты:** `tests/test_cache_store.py` (7) + `tests/test_prepared_signal.py` (9) → 198 → **214**
  pytest; инвентарь — `docs/rules/tests.md`.
- **Документация:** `docs/data_map.md` (строки кэша подготовленного сигнала и модуля кэша, §10 п.2
  закрыт), `docs/rules/data-and-caches.md` (правила 9–10, чек-лист), `AGENTS.md`, `todo.md`,
  `audit-2026-09.md` (A3/A4 закрыты).

## 17.09.2026 — рефакторинг документации (этап 1, код не тронут)

- Документация разрезана (детали и числа — `audit-2026-09.md` §4): `AGENTS.md` (106 КБ) → вход
  на 13.3 КБ + `docs/rules/*` (10 тематических файлов); `docs/ui.md` (130 КБ) → индекс `docs/ui.md`
  + `docs/ui/{shell,viewer,dipoles,table,eeg,roadmap}.md` с сохранением номеров §.
- Добавлены `docs/data_map.md` (карта данных: носители, ключи инвалидации, жизненный цикл, формат
  строки журнала шагов) и `docs/rules/docs.md` (правило ведения документации).
- Восстановлен структурный дефект: заголовок «Таблица локализации (срез 4)» снова стоит рядом со
  своими пунктами (в `AGENTS.md` его разделяла секция «Форма фильтров…»).
- Закрытый пункт из `todo.md`: в `README.md`/`AGENTS.md` команды `curl :8000/...` заменены на
  `curl http://localhost:8000/...` (в текущем окружении curl без схемы не работает) — сделано.

## ✅ Выполнено в этой сессии

### 1. Структура проекта
- [x] Создана структура папок (backend/app/{core,api,services,models,utils})
- [x] Все __init__.py созданы
- [x] Конфигурационные файлы: requirements.txt, Dockerfile, .env, docker-compose.yml, init_db.sql

### 2. Backend-код
- [x] core/config.py — Pydantic Settings (SQLite, пути FSAverage, upload/results dirs)
- [x] main.py — FastAPI entry-point с / и /init-status эндпоинтами
- [x] api/routes.py — REST API: /analyze, /brain-surface, /brodmann-labels
- [x] services/edf_loader.py — загрузка EDF + монтаж 10-20
- [x] services/artifact_detector.py — z-score, peak-to-peak, flat-line, ICA EOG
- [x] services/epoch_segmenter.py — нарезка без overlap [250-2000] мс
- [x] services/bandpass_filter.py — δ/θ/α/β/γ + кастомный + одиночная частота
- [x] services/dipole_fitter.py — fit_dipole + локализация (MNI, anatomy, BA)
- [x] utils/brain_export.py — экспорт surface-мешей FSAverage + BA labels
- [x] models/db.py — SQLAlchemy модели (SQLite для локали, PostgreSQL для prod)

### 3. Стартовая страница
- [x] static/index.html — визуальная страница с прогресс-индикацией
- [x] Эндпоинт GET / — отдаёт HTML
- [x] Эндпоинт GET /init-status — JSON статуса готовности (6 компонентов)

### 4. Исправления
- [x] Field импортирован из pydantic (а не pydantic_settings)
- [x] mne.read_labels_from_parc вместо несуществующего read_labels_from_mgovt
- [x] "mne.Covariance" как строковая аннотация типа
- [x] Переписана функция _find_ba (была сломана)
- [x] Исправлен путь к static (app/static, а не backend/static)
- [x] Убрано version: "3.9" из docker-compose.yml
- [x] .env обновлён для локального SQLite режима
- [x] Пути загрузки/результатов через settings.upload_dir и settings.results_dir

### 5. Проверка
- [x] Все импорты работают
- [x] Сервер запускается
- [x] GET / — index.html отдаётся (200)
- [x] GET /health — {"status":"ok"} (200)
- [x] GET /init-status — все компоненты "ready" (200)
- [x] GET /docs — Swagger UI доступен (200)

## 📂 Структура проекта

```
DipLock/
├── backend/
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py
│   │   ├── core/
│   │   │   ├── __init__.py
│   │   │   └── config.py
│   │   ├── api/
│   │   │   ├── __init__.py
│   │   │   └── routes.py
│   │   ├── services/
│   │   │   ├── __init__.py
│   │   │   ├── edf_loader.py
│   │   │   ├── artifact_detector.py
│   │   │   ├── epoch_segmenter.py
│   │   │   ├── bandpass_filter.py
│   │   │   └── dipole_fitter.py
│   │   ├── models/
│   │   │   ├── __init__.py
│   │   │   └── db.py
│   │   ├── utils/
│   │   │   ├── __init__.py
│   │   │   └── brain_export.py
│   │   └── static/
│   │       └── index.html  ← стартовая страница
│   ├── requirements.txt
│   ├── Dockerfile
│   ├── .env               ← НЕ коммитится
│   └── .env.example       ← шаблон конфигурации
├── data/  ← локальные данные
│   ├── edf/          ← test.edf уже существует
│   └── results/      ← результаты анализа (JSON, игнорируются)
├── docker-compose.yml  ← без version (устранено предупреждение)
├── init_db.sql
├── setup.sh
├── .gitignore
├── README.md
└── todo.md  ← это файл
```

### 6. Автотесты и исправления пайплайна (12.09.2026)
- [x] Подключён **pytest**: `backend/pytest.ini`, `requirements-dev.txt`, `backend/tests/`
- [x] 54 теста: валидация `/analyze`, `config`, `bandpass_filter`, `epoch_segmenter`, `edf_loader`, `dipole_fitter`, `brain_export`
- [x] Найдено и исправлено **17 багов**, из-за которых `/analyze` падал на реальных EDF
      (baseline, `psd_welch`→`compute_psd`, `n_fft`, имена/единицы каналов, `resample`, montage,
      фильтр raw, `Evoked` для диполей, Brodmann-атлас, BEM, nibabel, empirical cov,
      `mne.read_surface`, trimesh-децимация) — см. `audit.md`
- [x] Прореживание дипольного фитинга (`DIPOLE_FIT_DECIM`) и лимит эпох (`DIPOLE_FIT_MAX_EPOCHS`)
- [x] Проверка цепочки локализации: `head_to_mni` + Brodmann (`BA24-rh`) + анатомия + surface-экспорт
- [x] Исправлена несогласованность `/init-status`: URL БД из `settings` (был `os.getenv`)
- [x] Ручная проверка полного пайплайна на `data/edf/test.edf`

## 🎯 Статус: ✅ Готово к использованию для локальной разработки

Сервер: uvicorn app.main:app --host 0.0.0.0 --port 8000
URL: http://localhost:8000
