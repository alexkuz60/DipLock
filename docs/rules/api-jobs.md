# API и фоновые задачи

> Карта контракта. Нормативные правила — в `docs/rules/safety.md` (безопасность) и
> `docs/rules/data-and-caches.md` (кэши/артефакты). Полный аудит API — `audit-2026-09.md`.

## Где что лежит

- `backend/app/api/routes.py` — **51 роут**, префикс `/api/v1` из `settings.api_prefix`.
  Обработчик описывает форму (`Form`/`Query`) и контракт (`response_model`); всё остальное — рядом:
  - `api/assets.py` — отдача кэшируемых ассетов: `asset_response` (ETag, `Cache-Control`, 304);
  - `api/params.py` — формы → параметры сервисов и проверки с текстом для UI (400);
  - `api/recording_jobs.py` — задачи записи: `require_recording`, `submit_recording_job`,
    `job_status`, `recording_job_result`, `job_by_id`, воркеры (`WORKERS`);
  - `api/uploads.py` — приём EDF: `safe_edf_name`, `save_upload`, `MAX_UPLOAD_SIZE`;
  - `services/analysis_pipeline.py` — пайплайн файлового анализа (`/analyze`, `/jobs`) и запись
    результата в БД;
  - `services/job_store.py` — дисковый носитель завершённых задач (`results_dir/jobs/<job_id>.json`),
    из него `JobManager.restore` поднимает историю при старте (A8, этап 6). Сообщение и ошибка
    задачи остаются в её файле навсегда: тултип «Пересчитать» в UI показывает **историю прошлого
    запуска**, а не текущие числа (24.09.2026: «тултип и пиули врут по-разному»). Текущие числа —
    только в результате свежей задачи; «бэкенд не обновлён» ловит `init-status.code.stale`.
  - `services/orphans.py` — обход сирот при старте приложения: каталоги записей, их кэши и файлы
    задач исчезнувших записей (A6, этап 6);
  - `services/asset_versions.py` — входы и единый отпечаток версий ассетов (A7, этап 6);
  - `services/journal.py` — журнал шагов (`step`/`record`, `job_scope`): замеры шагов пайплайнов
    в `data/cache/journal.jsonl`, читается `GET /journal` (формат — `docs/data_map.md` §9).
- `backend/app/main.py` — 5 путей уровня приложения: `GET /`, `GET /ui/{path}`, `GET /legacy`,
  `GET /init-status`, `GET /health` (+ монтирование `/static`). Итого **56 HTTP-путей** (51 в `routes.py` + 5 уровня приложения).
- Контракт ответов — Pydantic-модели в `backend/app/schemas/` (всегда через `response_model`);
  из OpenAPI генерируются TS-типы `frontend/src/shared/api/schema.d.ts` (`npm run gen:api`;
  выгрузка `openapi.json` — `venv/bin/python -m scripts.export_openapi`, свежесть — pytest
  `test_openapi_json_is_up_to_date` и CI-шаг `git diff`, 4.2).
- Swagger: `http://localhost:8000/docs`.

## Инвентарь эндпоинтов (51 в `routes.py`, порядок файла)

| # | Метод и путь | Назначение |
|---|---|---|
| 1 | `POST /analyze` | синхронный полный анализ EDF (legacy-ветка) |
| 2 | `POST /recordings` | загрузка EDF для просмотра (sha256-дедуп, без обработки) |
| 3 | `GET /recordings/{id}` | паспорт записи |
| 4 | `DELETE /recordings/{id}` | **удаление записи целиком** (4.4): файл, кэши и строки БД каскадом (§8.4.3); 204, повторный — 404. Явное действие пользователя: TTL записей по умолчанию выключен («записи — не 24 ч») |
| 5 | `GET /sessions` | **read-API сессий** (4.7): страница `sessions` с фильтрами `recording_id`/`kind`, пагинацией `limit`/`offset`, честным `total` и счётчиками детей (эпохи/отбраковано/диполи) |
| 6 | `GET /sessions/{id}` | паспорт сессии: те же счётчики + `power_bands` (ключи мощностей `epochs`); 404 — не найдена |
| 7 | `GET /sessions/{id}/epochs` | сетка эпох с мощностями полос (None — «не измерено»), пагинация по `epoch_index`; 404 — нет сессии |
| 8 | `GET /sessions/{id}/dipoles` | строки диполей для агрегатов Фазы 5 (фильтр `freq_band`, пагинация по эпохам); 404 — нет сессии |
| 9 | `GET /recordings/{id}/signals` | пирамида огибающей ×1…×16 и слои видимости `layer=raw\|cleaned\|diff` (контейнер `DPS1`, ETag включает слой и параметры подготовки — в т.ч. отменённые зоны `exclude_zone_ids`, шаг 2) |
| 10 | `POST /recordings/{id}/preprocess` | стадия предподготовки: `filter` / `artifacts` / `epochs` (опции очистки формы, включая отменённые зоны вклада `exclude_zone_ids` через запятую — шаг 2; неизвестный id не 400, а warning в отчёте) |
| 11 | `GET /recordings/{id}/preprocess/{job_id}` | результат стадии |
| 12 | `POST /recordings/{id}/evoked` | ERP-усреднение по событиям (шаг 2.7: стимул → эпоха → усреднение) |
| 13 | `GET /recordings/{id}/evoked/{job_id}` | результат ERP: усреднённая волна [канал][время] + `n_used`/`n_total` |
| 14 | `POST /recordings/{id}/spectrum` | спектр δ…γ (Welch или multitaper PSD, `psd_method`; 1/f + пики specparam) |
| 15 | `GET /recordings/{id}/spectrum/{job_id}` | результат спектра |
| 16 | `GET /recordings/{id}/spectrum/topomap/{band}.png` | топокарта диапазона (PNG, ETag) |
| 17 | `POST /compare` | **дифференциальный анализ двух записей** (B9, задача «Сравнение»): шлюз пары (разные записи, одинаковый sfreq, ≥1 общий канал — 400), затем задача `kind=compare` (пара — не запись, поэтому не в `RECORDING_JOB_KINDS`) |
| 18 | `GET /compare/{job_id}` | результат сравнения (`CompareResult`): дельты по полосам (B − A), кластерный тест MNE, ссылки на карты разности; 404 — чужой/неизвестный job, 409 — идёт/упал |
| 19 | `GET /compare/topomap/{band}.png` | карта разности B−A полосы (PNG, ETag; подпись включает параметры и **обе** записи; промах кэша — ленивый пересчёт пары) |
| 20 | `POST /recordings/{id}/dipoles` | быстрый расчёт диполей (перебор сетки; одна точка на эпоху) |
| 21 | `GET /recordings/{id}/dipoles/{job_id}` | результат быстрого расчёта |
| 22 | `POST /recordings/{id}/dipole_refine` | точное уточнение одной эпохи (BEM fit_dipole, F19) |
| 23 | `GET /recordings/{id}/dipole_refine/{job_id}` | результат уточнения («было/стало») |
| 24 | `POST /recordings/{id}/report` | **автоотчёт** (раздел «Итоги», §3.9): три стадии EDF (часть 1, `fixed`-нарезка) → пакет диполей по полосам (`bands` через запятую, `grid_mm`) → HTML `mne.Report` в кэш |
| 25 | `GET /recordings/{id}/report/{job_id}` | агрегаты отчёта (QC, эпохи, полосы) + `html_url` |
| 26 | `GET /recordings/{id}/report/{job_id}/html` | HTML отчёта из дискового кэша (самодостаточный MNE.Report, ETag/304) |
| 27 | `POST /recordings/{id}/spectrogram` | спектрограмма канала (STFT) |
| 28 | `GET /recordings/{id}/spectrogram/{job_id}` | метаданные сетки |
| 29 | `GET /recordings/{id}/spectrogram/{job_id}/grid.bin` | сетка дБ (float32, контейнер `DPS2`, ETag) |
| 30 | `POST /jobs` | анализ фоновой задачей (legacy, с прогрессом) |
| 31 | `GET /jobs` | история задач |
| 32 | `GET /jobs/{job_id}` | состояние задачи |
| 33 | `DELETE /jobs/{job_id}` | отмена задачи (3.2): 404 — не найдена, 409 — уже завершена, иначе 200 со статусом `cancelled` |
| 34 | `GET /jobs/{job_id}/result` | результат завершённой задачи |
| 35 | `GET /surface` | меш fsaverage (кэш + ETag) |
| 33–34 | `GET /surface/brodmann`, `/surface/brodmann/{area_name}` | индексы вершин полей Бродмана |
| 35–36 | `GET /surface/mri`, `/surface/mri/slice/{plane}/{mm}.png` | метаданные срезов и срез картинкой (ETag) |
| 40 | `GET /surface/mri/volume/{name}` | том fsaverage «как есть» для Niivue (3.5): белый список имён (`T1.mgz`, `seghead.mgz`, `lh.white`, `rh.white`), байты без перекодирования, ETag по отпечатку файлов (kind `volumes`); чужое имя — 404 до чтения файловой системы |
| 38–39 | `GET /surface/contours`, `/surface/contours/{plane}/{mm}` | метаданные и контуры структур/полей/силуэта головы (ETag; поле `head` — контур `seghead.mgz`, 3.5) |
| 43 | `GET /brodmann-labels` | имена доступных полей Бродмана |
| 44 | `GET /brain-surface` | устаревший алиас `/surface` |
| 45 | `GET /filter-response` | АЧХ применяемого фильтра (полоса + notch с гармониками; шаг 2.5, лёгкий расчёт без задачи и ETag) |
| 46 | `GET /recordings/{id}/mains` | сигнал сетевого фона: уровни линий L1 и вырезанная notch-компонентная за окно (`notch_hz`, `notch_harmonics`, `start_sec`, `duration_sec`; лёгкий расчёт без задачи и ETag) |
| 47 | `GET /meta` | версии, окружение, параметры расчёта, ссылки на ассеты, позиции датчиков карты-силуэта (`channel_positions`) |
| 48 | `GET /journal` | журнал шагов: последние замеры (`limit` 1–2000, фильтр `pipeline`) |
| 49 | `POST /server/restart` | **перезапуск бэкенда из UI** (202 → `os.execv` после ответа; guard'ы: только режим лаунчера по `settings.server_pid_file`, `--reload` → 409, активные задачи → 409; `services/server_control.py`) |
| 50 | `GET /resource` | **локальный ресурс**: автоопределение GPU (имя, память, CuPy, причина отказа) + тумблер `use_cuda` (`services/gpu.py`; детекция в `asyncio.to_thread`) |
| 51 | `PUT /resource` | тумблер «Использовать GPU» → MNE-конфиг сервера (`MNE_USE_CUDA`); 409 — CUDA недоступна, `detail` — причина для UI |

**Чего в API нет осознанно:** листинга записей. «Закрыть запись» в UI остаётся **клиентским**
действием (сброс состояния), а явное удаление — `DELETE /recordings/{id}` (4.4): TTL записей
по умолчанию выключен («записи — не 24 ч», `RECORDINGS_TTL_HOURS=0`), файл и кэши уходят
вместе с строками БД каскадом (§8.4.3, `services/recording_store.py`); `_drop_signal_cache`
чистит кэши и при вытеснении лимитом истории. Запись в БД — best-effort (правило 13).


## Правила

1. **Контракт — только через схемы.** «Сырых» `dict` в ответах не добавляем: `response_model`
   обязателен, иначе ломается генерация TS-типов и `npm run typecheck` в UI.
2. **Задача = job, и только по кнопке.** Расчёт стартует исключительно `POST …/{kind}`:
   `202` + `job_id` → поллинг `GET …/{job_id}` → `result_url` из `job_status`
   (`app/api/recording_jobs.py`).
   Новый вид задачи (`kind`) обязан быть добавлен и в `RECORDING_JOB_KINDS` + `WORKERS`
   (сборка `result_url` и запуск), и в `_drop_signal_cache` (чистка кэшей записи — дисковых и
   RAM-кэша подготовленного сигнала) — иначе результат «потеряется» после вытеснения.
   Сейчас kind: `analyze`, `preprocess`, `spectrum`, `dipoles`, `spectrogram`, `dipole_refine`,
   `evoked` (его результат кэшей записи не создаёт — чистить в `_drop_signal_cache` нечего).
   На стороне UI задача описана **одной парой** методов клиента (`recordingJob(kind)` в
   `shared/api/client.ts`: `start` + `result`), а ожидание завершения — единым `waitForJob`
   (`shared/lib/jobPolling.ts`); своих копий поллинга в сторах нет (правило 7 —
   `docs/rules/frontend-state.md`).
3. **Тяжёлое — не в `async def`.** MNE/CPU-операции идут в job-очередь (`job_manager`) или в
   `asyncio.to_thread`; блокирующий вызов в хэндлере вешает событийный цикл для всех клиентов.
4. **ETag/304 и версии ассетов** — только через `app/api/assets.py` (`asset_response`): кавычки
   ETag, `Cache-Control` (`CACHE_PUBLIC_WEEK` / `CACHE_PRIVATE_HOUR` и др.), заголовки `X-…` и
   условие 304 собираются в одном месте. Ручных копий в роутах быть не должно —
   `tests/test_api_assets.py` провалится, если `status_code=304` появится вне `assets.py`.
   Клиент кэширует по URL, поэтому URL картинки/сетки обязан нести параметры расчёта и
   `?v={asset_version}`.
5. **`None`, а не `NaN`.** Не измеренная величина (диапазон вне частотной оси, отсутствующие
   координаты) отдаётся как `null`, UI показывает «—». `NaN` невалиден в JSON.
6. **Ошибки раздельно.** Ошибка задачи хранится отдельным полем (`error` / `spectrumError`):
   общий текст показывал бы сбой локализации как «спектр не рассчитан».
7. **Прогресс — по эпохам.** Пакетные задачи вызывают `set_progress(..., epochs_done=…,
   epochs_total=…)`: «эпох 12 из 30» читается лучше дробного прогресса; `Job.elapsed_sec` —
   грубая длительность всего job, для пошаговых замеров есть журнал шагов (`GET /journal`,
   формат — `docs/data_map.md` §9). Новый шаг пайплайна оборачивается `journal.step(...)`:
   «числа о времени» в документации берутся **только** оттуда (`docs/rules/docs.md` п.6).
8. **Валидация входа.** Размер загружаемого EDF проверяется до записи на диск; параметры расчёта
   зажаты схемами (`ge`/`le`) — UI дублирует зажимы, но сервер обязан проверять сам.
9. **Результат задачи переживает рестарт процесса (A8, этап 6).** Завершённая задача — и успешная, и
   упавшая — пишется файлом `results_dir/jobs/<job_id>.json` (`services/job_store.py`), а на старте
   `JobManager.restore` возвращает её в историю: `GET /jobs`, `GET /jobs/{id}` и `result_url`
   (`/recordings/{id}/{kind}/{job_id}`) снова работают после `--reload` и перезапуска сервера.
   Три следствия для новых задач: результат больше `JOB_RESULT_MAX_BYTES` **не** сохраняется (задача
   остаётся в истории, а результат отдаёт `409` с текстом «не сохранён на диск» — третий текст
   `_require_finished` рядом с «ещё не завершена» и «завершилась ошибкой»); тяжёлые артефакты в файл
   задачи не кладём — они живут в дисковых кэшах по подписи; файлы задач исчезнувших записей и лишнюю
   историю сносит обход сирот (`services/orphans.py`), поэтому новая задача с `recording_id` в `meta`
   попадает под тот же обход автоматически. `JOB_STORE_ENABLED=false` оставляет прежний режим
   «результат живёт в сессии».
10. **Задача не «успех» без результата (F18, этап 7).** Падение шага, которое пересчитывается
   поштучно (эпоха дипольного фитинга), обязано попадать в результат счётчиком и предупреждением —
   `n_dipole_fit` / `n_dipole_errors` / `dipole_error_samples` + `warnings` (`AnalyzeResponse`), —
   а не только строкой в логе: иначе UI показывает «Задача выполнена» при пустом результате.
   `dipole_error_samples` усечены до пяти текстов (контракт не растёт вместе с числом эпох), полный
   список ошибок остаётся в дампе `results/{session_id}.json` (`dipole_fit`). Потребителя у
   legacy-результата `/jobs/{kind}/{job_id}` пока нет (`api.jobResult` в
   `frontend/src/shared/api/client.ts` объявлен, но не используется): предупреждение обязано ехать
   вместе с результатом **до** того, как такой потребитель появится.
11. **Эпохи — часть контракта legacy-результата (F21, этап 7).** `AnalyzeResponse` отдаёт поле
   `epochs: EpochSummary[]` — **все** нарезанные эпохи (`epoch_index`, `start_time_sec`, `duration_ms`,
   `has_artifact`, `band_powers`), а не только вошедшие в анализ: это единственный источник строк
   таблицы `epochs` в БД и связи `dipoles.epoch_id`. `has_artifact=true` означает «эпоха не вошла в
   анализ» (пересечение с BAD_-зоной детектора или неполное окно в конце записи), `band_powers` у таких эпох пуст
   (в БД — NULL, а не 0: ноль был бы утверждением о сигнале). Меняете нарезку — правьте
   `epoch_records` (`services/epoch_segmenter.py`), а не подставляйте `epochs.events`: в MNE это
   уже отфильтрованный список.

12. **Отмена задачи — кооперативная (3.2).** `DELETE /jobs/{id}` лишь ставит флаг:
    воркер-поток узнаёт об отмене на ближайшем тике `set_progress` (бросает
    `JobCancelledError` из `services/job_manager.py`) и задача становится `cancelled`;
    если воркер успел дойти до конца — его результат отбрасывается. Задача в очереди
    отменяется сразу и воркер не запускается; файл задачи хранит `cancelled` как любой
    статус (переживает рестарт). Тексты разбора отдельные (правило 6): результат
    отменённой задачи — 409 «Задача отменена — запустите расчёт заново», `DELETE`
    завершённой — 409 «уже завершена», повторный `DELETE` отменённой — 200. Клиент
    читает `cancelled` как отмену (`JobCancelledError` в `shared/lib/jobPolling.ts`),
    а не ошибку, и локальный статус ставит сам (`cancelRemoteJob`).
13. **Успешная задача записи оставляет строку в БД (4.4, write-API).** Виды
    `preprocess` (стадия `epochs`)/`dipoles`/`dipole_refine`/`spectrogram`/`report`
    пишутся через `on_success` (`services/results_store.py`) — колбэк
    `job_manager`, его ошибки логируются и **не меняют статус задачи** (расчёт
    важнее БД, как у `save_analysis_to_db`); `spectrum`/`evoked` не пишутся
    (осознанный предел 4.4). Схема, инварианты «история не UPSERT»/«TTL строки =
    TTL записи» и внутренние ключи результата — `docs/rules/results-db.md`.
    Строка записи (`recordings`) создаётся при `POST /recordings` и чистится
    обходом сирот; наружу write-API не светится — read-API сессий будет в 4.7.

