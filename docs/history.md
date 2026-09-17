# История работ DipLock

> Журнал выполненных работ: сюда переносится всё закрытое из `todo.md` (дословно),
> чтобы текущий список задач оставался коротким. Новые записи — сверху, датой среза.

## 17.09.2026 — этап 6: жизненный цикл данных (A6/A7/A8)

Закрытый пункт `todo.md` (перенесён дословно): **«Этап 6: обход сирот кэша (A6; каталог
`edf/` в `data/cache/spectrograms/` — уже сирота), единый отпечаток версий ассетов (A7), решение по
сохранению результатов задач (A8)»**.

Что сделано:

- **A6 — обход сирот, `services/orphans.py`.** До этого `prune_orphans` вызывался только из скрипта
  и тестов, а кэш исчезнувшей записи не убирал никто (`_drop_signal_cache` срабатывает лишь при
  вытеснении через реестр). `sweep_orphans(cfg, registry=…)` за один проход сводит три вида мусора:
  каталоги загрузок без живого владельца (TTL, через `RecordingRegistry.prune_orphans`), кэши
  `signals`/`spectra`/`spectrograms` записи, которой нет **ни** в реестре, **ни** на диске
  (`RecordingRegistry.known_ids` + `upload_root`), и файлы задач исчезнувших записей (A8). Вызовы:
  lifespan приложения (`main.py`) и `backend/scripts/dedupe_recordings.py --prune`; уборка
  best-effort — исключение логируется, старт не ломается. Отчёт `SweepReport` (сколько каталогов,
  кэшей, файлов задач и байт) идёт в лог. Новые публичные методы реестра: `known_ids`, `upload_root`.
- **A7 — один отпечаток ассетов, `services/asset_versions.py`.** Пять версий с разными способами
  подъёма сведены к одному источнику: входы ассетов (номера сборки `SURFACE_VERSION` = 1,
  `MRI_GRID_VERSION` = 2, `CONTOUR_VERSION` = 2; параметры — шаг и границы MNI-сетки, окно
  интенсивности, упрощение контура, минимальная площадь, метод BA, смещение id полушарий; списки
  файлов FreeSurfer) объявлены в `ASSET_SPECS`, отпечаток считается одной функцией
  `fingerprint(kind, subjects_dir)` = sha256(kind:version + params + size/mtime файлов)[:16].
  `surface_cache.surface_version`, `mri_slices.mri_version`, `atlas_contours.contour_version` стали
  тонкими вызовами (шесть копий хеширования и трёх списков файлов больше нет); `mri_slices` и
  `atlas_contours` берут константы оттуда же. Расчётные `topomap_version`/`grid_version` осознанно
  **не** трогали: это отпечатки расчёта, они меняются вместе с параметрами. Следствие: отпечатки
  сменились → дисковые кэши ассетов пересобираются один раз (~1.6 с на меш).
- **A8 — результат задачи переживает рестарт, `services/job_store.py`.** Раньше `Job` жил только в
  RAM: после `--reload` история пустела, а `GET /jobs/{id}` и `result_url` отвечали 404. Теперь
  завершённая задача (и успех, и ошибка) пишется в `results_dir/jobs/<job_id>.json` (`Job.to_record`
  / `Job.from_record`, даты — ISO, версия формата `RECORD_VERSION`), а `JobManager.restore` при
  старте поднимает записи в историю с флагом `restored`. Запись идёт `asyncio.to_thread` **после**
  освобождения слота семафора и никогда не роняет задачу (`cache_store.cache_write` — единственная
  копия «tmp + `os.replace`»). Тяжёлые артефакты остаются в кэшах: результат больше
  `JOB_RESULT_MAX_BYTES` = 2 МБ не сохраняется (флаг `result_omitted`), а API отвечает `409`
  третьим текстом — «результат не сохранён на диск» (рядом с «ещё не завершена» и «завершилась
  ошибкой»). Новые настройки: `JOB_STORE_ENABLED`, `JOB_RESULT_MAX_BYTES`.
- **Проводка и границы.** `main.py` получил lifespan: обход сирот → подъём истории задач. Новые
  инварианты — `docs/rules/data-and-caches.md` п.12–14 (версии ассетов, обход сирот, файл задачи),
  правило 9 — `docs/rules/api-jobs.md`. Обновлены `docs/data_map.md` (§0 носители, §7 версии, §8
  результат и файл задачи, новый §10 с живым прогоном), `AGENTS.md` (структура, конвенции),
  `backend/.env.example`, `docs/rules/atlas-mri.md`, `docs/rules/tests.md`.
- **Тесты (23 новых, всего 305 pytest):** `tests/test_orphans.py` (7), `tests/test_asset_versions.py`
  (8 — включая снапшот входов ассетов: изменение входа без подъёма версии падает), `tests/test_job_store.py`
  (8 — запись/подъём, ошибка, предел размера, выключение, уборка, защита пути).
- **Живой прогон** (реальные `data/`): первым стартом удалена сирота аудита — каталог `edf/` в
  `data/cache/spectrograms/` (2 файла, 169 КБ), остальные каталоги кэшей живы; задача
  `spectrogram` (`data/edf/test.edf`, канал F3, окно 500 мс) записалась на диск, а после
  **пересоздания `TestClient`** (аналог рестарта процесса) `GET /jobs/{id}` и `result_url` отвечали
  так же, как до него — история пережила обе задачи (успешную и упавшую). Числа шагов — из журнала
  (этап 5): `load_edf` 130.3 (холодное чтение, RAM-кэш сигнала пуст) → `stft` 4.9 (1051 окно) →
  `grid_write` 0.2 мс (88 568 Б `DPS2`).

## 17.09.2026 — этап 5: журнал шагов (A5)

Закрытый пункт `todo.md` (перенесён дословно): **«Этап 5: журнал шагов (A5) — формат и поля в
`docs/data_map.md` §9»**.

Что сделано:

- **`services/journal.py` — один замер на весь проект.** `step()` — контекст-менеджер: `perf_counter`
  на входе и выходе, строка при выходе, в том числе **при исключении** (в `note` добавляется
  `error=…`: упавший шаг обязан быть виден, иначе «почему задача упала» выясняется по тексту ошибки
  задачи); `record()` — для уже измеренного шага (ступень или сумма по циклу). Поля можно дополнить
  внутри блока (`entry.bytes_out = len(blob)`). До этого время мерилось в шести несвязанных местах
  (`duration_sec_calc`, `Job.elapsed_sec`, `duration_sec` в `/analyze`).
- **`job_id` проставляет `job_scope` (ContextVar) вокруг `asyncio.to_thread`** в `job_manager._execute`:
  контекст доезжает до потока задачи, потому что `to_thread` копирует контекст, и сервисы пишут
  `job_id` **без параметров** (про задачи не знают). Синхронный вызов (`/analyze`, тесты) пишет
  прочерк — в файле `-`, в API он превращается в `null` (правило «неизмеренное — `null`»).
- **Носитель — `data/cache/journal.jsonl`** (под `CACHE_DIR`, не коммитится). Дописывание под локом
  (шаги идут из нескольких потоков job-очереди), перед записью сверяется `JOURNAL_MAX_BYTES`
  (5 МБ по умолчанию): полное поколение уезжает в `journal.jsonl.1`, старше — перезаписывается,
  поэтому на диске всегда не больше двух файлов. Чтение — только «хвост» (1 МБ): журнал читают ради
  последних шагов. `JOURNAL_ENABLED=false` выключает запись; **сбой записи логируется и гасится** —
  журнал не может сломать расчёт (то же правило, что у кэшей в `cache_store`).
- **Роут `GET /api/v1/journal`** (`limit` 1–2000, фильтр `pipeline`, `response_model=JournalOut`):
  `enabled`, путь файла, список строк. Отсутствие файла — пустой список, а не 404. UI журнал не
  читает: это диагностика разработчика (`docs/data_map.md` §9).
- **`params_key` — та же сигнатура, что у кэша результата** (`spectrum_signature`, ключ
  подготовленного сигнала `PreparedKey.signature()`, ETag уровня сигналов, версия ассета): замер
  можно сопоставить с записью в кэше и понять, за что заплачено.
- **Проводка по всем продакшен-пайплайнам:** `signals` (`cache_read`/`build_level`), `preprocess-*`
  (+`load_edf` из кэша подготовленного сигнала), `spectrum` (`load_edf`/`segment_epochs`/`psd`/
  `topomaps`/`topomap_read`), `spectrogram` (`load_edf`/`stft`/`grid_write`/`grid_read`), `dipoles`
  (`load_edf`/`segment_epochs`/`grid_scan`/`head_to_mni`), `analyze` (стадии legacy-пайплайна),
  `asset-{surface|mri|contours}` (`cache_read`/`build`). Замеры стоят в продакшен-пути, а не в
  отдельном профилировщике: иначе «стало быстрее» невоспроизводимо.
- **Цикл = одна строка.** На `test.edf` это 261 эпоха — строка на эпоху засорила бы журнал: пишется
  остаток «перебор сетки» (цикл минус локализация) и `head_to_mni` — сумма `head_to_mni` + чтения
  структуры атласа по точкам.
- **Журнал нашёл дефект замера в `dipole_scanner` (и он исправлен).** `_structure_of` вызывался вне
  измеряемого окна (в литерале словаря точки), поэтому первая сборка объёмов атласа (≈1 с) попадала
  не в строку локализации, а в остаток «перебор сетки»: 7 мм выглядели как 3.2 с перебора, хотя
  честно — 2015 мс перебора и 1356 мс локализации (внутри 962 мс — разовая сборка атласа). Теперь
  `_structure_of` читается внутри измеряемого блока.
- **Попутный багфикс:** `raw.nchan` → `raw.info["nchan"]` в `prepared_signal` и `analysis_pipeline`
  (`raw.nchan` в новых версиях MNE — число каналов + 1, `bytes_in` в журнале был бы враньём).
- **Тесты:** `tests/test_journal.py` — 12 (формат строки и все поля, прочерк → `null`, запись при
  исключении с `error=…` и проброс ошибки, `job_scope` возвращает прежний контекст, выключенный
  журнал, сбой записи не ломает расчёт (warning и пустой хвост), битые и чужие строки
  пропускаются, ротация на два поколения, фильтр по `pipeline` и `limit`, `cache_hit` у кэша
  подготовленного сигнала, шаги задачи несут `job_id`, пустой роут и валидация `limit`).
  Всего backend: **282 теста** (было 270).
- **Первые замеры журнала** (17.09.2026, `data/edf/test.edf`, скрипт на живом файле через `TestClient`,
  таблица — `docs/data_map.md` §9): `spectrogram` — `load_edf` 93 мс → `stft` 3.5 мс → `grid_write`
  0.2 мс; `spectrum` — `load_edf` 2.2 мс (**кэш-попадание**) → `psd` 486 мс; `dipoles` (7 мм, 261 точка) —
  `grid_scan` 2133 мс → `head_to_mni` 1429 мс (из них `asset-contours build` 1010 мс, первое обращение).
  Сумма строк сходится с длительностью задачи (3.6 с), независимые замеры аудита подтвердились
  («сборка объёмов 1.0 с»).
- **Документация:** `docs/data_map.md` (§0 — носитель журнала, §8 — строка «Пошаговые замеры»,
  §9 — реализация и первые замеры), `docs/rules/api-jobs.md` (29 роутов, 34 пути, инвентарь,
  правило 7 — замер только из журнала), `docs/rules/data-and-caches.md` (инвариант 11: журнал —
  артефакт, а не кэш), `docs/rules/tests.md`, `backend/.env.example` (`JOURNAL_ENABLED`,
  `JOURNAL_MAX_BYTES`), `AGENTS.md` (дерево сервисов, число роутов), `audit-2026-09.md` (A5 закрыт).



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
