# API и фоновые задачи

> Карта контракта. Нормативные правила — в `docs/rules/safety.md` (безопасность) и
> `docs/rules/data-and-caches.md` (кэши/артефакты). Полный аудит API — `audit-2026-09.md`.

## Где что лежит

- `backend/app/api/routes.py` — **28 роутов**, префикс `/api/v1` из `settings.api_prefix`.
  Обработчик описывает форму (`Form`/`Query`) и контракт (`response_model`); всё остальное — рядом:
  - `api/assets.py` — отдача кэшируемых ассетов: `asset_response` (ETag, `Cache-Control`, 304);
  - `api/params.py` — формы → параметры сервисов и проверки с текстом для UI (400);
  - `api/recording_jobs.py` — задачи записи: `require_recording`, `submit_recording_job`,
    `job_status`, `recording_job_result`, `job_by_id`, воркеры (`WORKERS`);
  - `api/uploads.py` — приём EDF: `safe_edf_name`, `save_upload`, `MAX_UPLOAD_SIZE`;
  - `services/analysis_pipeline.py` — пайплайн файлового анализа (`/analyze`, `/jobs`) и запись
    результата в БД.
- `backend/app/main.py` — 5 путей уровня приложения: `GET /`, `GET /ui/{path}`, `GET /legacy`,
  `GET /init-status`, `GET /health` (+ монтирование `/static`). Итого **33 HTTP-пути**.
- Контракт ответов — Pydantic-модели в `backend/app/schemas/` (всегда через `response_model`);
  из OpenAPI генерируются TS-типы `frontend/src/shared/api/types.ts`.
- Swagger: `http://localhost:8000/docs`.

## Инвентарь эндпоинтов (28 в `routes.py`)

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
   Сейчас kind: `analyze`, `preprocess`, `spectrum`, `dipoles`, `spectrogram`.
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
   грубая длительность всего job, для пошаговых замеров есть журнал шагов (`docs/data_map.md`).
8. **Валидация входа.** Размер загружаемого EDF проверяется до записи на диск; параметры расчёта
   зажаты схемами (`ge`/`le`) — UI дублирует зажимы, но сервер обязан проверять сам.
