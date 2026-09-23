# API и фоновые задачи

> Карта контракта. Нормативные правила — в `docs/rules/safety.md` (безопасность) и
> `docs/rules/data-and-caches.md` (кэши/артефакты). Полный аудит API — `audit-2026-09.md`.

## Где что лежит

- `backend/app/api/routes.py` — **29 роутов**, префикс `/api/v1` из `settings.api_prefix`.
  Обработчик описывает форму (`Form`/`Query`) и контракт (`response_model`); всё остальное — рядом:
  - `api/assets.py` — отдача кэшируемых ассетов: `asset_response` (ETag, `Cache-Control`, 304);
  - `api/params.py` — формы → параметры сервисов и проверки с текстом для UI (400);
  - `api/recording_jobs.py` — задачи записи: `require_recording`, `submit_recording_job`,
    `job_status`, `recording_job_result`, `job_by_id`, воркеры (`WORKERS`);
  - `api/uploads.py` — приём EDF: `safe_edf_name`, `save_upload`, `MAX_UPLOAD_SIZE`;
  - `services/analysis_pipeline.py` — пайплайн файлового анализа (`/analyze`, `/jobs`) и запись
    результата в БД;
  - `services/job_store.py` — дисковый носитель завершённых задач (`results_dir/jobs/<job_id>.json`),
    из него `JobManager.restore` поднимает историю при старте (A8, этап 6);
  - `services/orphans.py` — обход сирот при старте приложения: каталоги записей, их кэши и файлы
    задач исчезнувших записей (A6, этап 6);
  - `services/asset_versions.py` — входы и единый отпечаток версий ассетов (A7, этап 6);
  - `services/journal.py` — журнал шагов (`step`/`record`, `job_scope`): замеры шагов пайплайнов
    в `data/cache/journal.jsonl`, читается `GET /journal` (формат — `docs/data_map.md` §9).
- `backend/app/main.py` — 5 путей уровня приложения: `GET /`, `GET /ui/{path}`, `GET /legacy`,
  `GET /init-status`, `GET /health` (+ монтирование `/static`). Итого **34 HTTP-пути**.
- Контракт ответов — Pydantic-модели в `backend/app/schemas/` (всегда через `response_model`);
  из OpenAPI генерируются TS-типы `frontend/src/shared/api/types.ts`.
- Swagger: `http://localhost:8000/docs`.

## Инвентарь эндпоинтов (29 в `routes.py`)

| # | Метод и путь | Назначение |
|---|---|---|
| 1 | `POST /analyze` | синхронный полный анализ EDF (legacy-ветка) |
| 2 | `POST /recordings` | загрузка EDF для просмотра (sha256-дедуп, без обработки) |
| 3 | `GET /recordings/{id}` | паспорт записи |
| 4 | `GET /recordings/{id}/signals` | пирамида огибающей ×1…×16 (контейнер `DPS1`, ETag) |
| 5 | `POST /recordings/{id}/preprocess` | стадия предподготовки: `filter` / `artifacts` / `epochs` |
| 6 | `GET /recordings/{id}/preprocess/{job_id}` | результат стадии |
| 7 | `POST /recordings/{id}/spectrum` | спектр δ…γ (Welch PSD) |
| 8 | `GET /recordings/{id}/spectrum/{job_id}` | результат спектра |
| 9 | `GET /recordings/{id}/spectrum/topomap/{band}.png` | топокарта диапазона (PNG, ETag) |
| 10 | `POST /recordings/{id}/dipoles` | быстрый расчёт диполей (перебор сетки; одна точка на эпоху) |
| 11 | `GET /recordings/{id}/dipoles/{job_id}` | результат быстрого расчёта |
| 12 | `POST /recordings/{id}/spectrogram` | спектрограмма канала (STFT) |
| 13 | `GET /recordings/{id}/spectrogram/{job_id}` | метаданные сетки |
| 14 | `GET /recordings/{id}/spectrogram/{job_id}/grid.bin` | сетка дБ (float32, контейнер `DPS2`, ETag) |
| 15 | `POST /recordings/{id}/dipole_refine` | точное уточнение одной эпохи (BEM fit_dipole, F19) |
| 16 | `GET /recordings/{id}/dipole_refine/{job_id}` | результат уточнения («было/стало») |
| 15 | `POST /jobs` | анализ фоновой задачей (legacy, с прогрессом) |
| 16 | `GET /jobs` | история задач |
| 17 | `GET /jobs/{job_id}` | состояние задачи |
| 18 | `GET /jobs/{job_id}/result` | результат завершённой задачи |
| 19 | `GET /surface` | меш fsaverage (кэш + ETag) |
| 20–21 | `GET /surface/brodmann`, `/surface/brodmann/{area_name}` | индексы вершин полей Бродмана |
| 22–23 | `GET /surface/mri`, `/surface/mri/slice/{plane}/{mm}.png` | метаданные срезов и срез картинкой (ETag) |
| 24–25 | `GET /surface/contours`, `/surface/contours/{plane}/{mm}` | метаданные и контуры структур/полей (ETag) |
| 26 | `GET /brodmann-labels` | имена доступных полей Бродмана |
| 27 | `GET /brain-surface` | устаревший алиас `/surface` |
| 28 | `GET /meta` | версии, окружение, параметры расчёта, ссылки на ассеты |
| 29 | `GET /journal` | журнал шагов: последние замеры (`limit` 1–2000, фильтр `pipeline`) |

**Чего в API нет осознанно:** листинга и удаления записей. «Закрыть запись» — **клиентское**
действие (сброс состояния UI), файл остаётся на диске и сносится TTL-обходом реестра;
`_drop_signal_cache` чистит кэши записи при вытеснении. Не добавляйте «DELETE ради кнопки»:
это меняет жизненный цикл данных (см. `docs/data_map.md`).


## Правила

1. **Контракт — только через схемы.** «Сырых» `dict` в ответах не добавляем: `response_model`
   обязателен, иначе ломается генерация TS-типов и `npm run typecheck` в UI.
2. **Задача = job, и только по кнопке.** Расчёт стартует исключительно `POST …/{kind}`:
   `202` + `job_id` → поллинг `GET …/{job_id}` → `result_url` из `job_status`
   (`app/api/recording_jobs.py`).
   Новый вид задачи (`kind`) обязан быть добавлен и в `RECORDING_JOB_KINDS` + `WORKERS`
   (сборка `result_url` и запуск), и в `_drop_signal_cache` (чистка кэшей записи — дисковых и
   RAM-кэша подготовленного сигнала) — иначе результат «потеряется» после вытеснения.
   Сейчас kind: `analyze`, `preprocess`, `spectrum`, `dipoles`, `spectrogram`, `dipole_refine`.
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


