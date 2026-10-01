# База результатов (4.4): write-API, TTL строк, PHI-псевдоним

> Появился вместе с срезом 4.4 (01.10.2026): схема — `docs/data-blocks.md` §8.1–§8.4
> (утверждена делегированным решением владельца), порядок внедрения шагов — §8.4.

## Таблицы и их владельцы (кто пишет)

| Таблица | Кто пишет | Что внутри |
|---|---|---|
| `recordings` | `POST /recordings` → `services/recording_store.upsert_recording` | зеркало реестра (B1): паспорт в мини-виде, `digest` (unique — дедуп), `patient_alias`, `created_at`/`accessed_at` (метрика TTL) |
| `sessions`/`epochs`/`dipoles` | legacy `/analyze` (`save_analysis_to_db`) **и** write-API шаг ② (`services/results_store.py`) | `sessions.recording_id`/`kind`/`job_id`/`params_json` — происхождение и параметры прогона UI; `dipoles.method` = `fast_grid`\|`bem_fit` (NULL у legacy) |
| `analyses`/`analysis_bands`/`dipole_points` | write-API шаг ③ — прогон автоотчёта (B7/B6, §8.3) | одна строка на прогон пакета, статус полосы, точки с UNIQUE «эпоха × поддиапазон» |
| `report_runs`/`report_band_summaries`/`report_name_counts`/`report_dynamics` | там же (B13) | история прогонов отчёта; `report_runs.analyses_id` — вариант (а): одна истина на прогон |

**Кто не пишет:** `spectrum`/`evoked` — осознанный предел 4.4 (их агрегаты живут в кэшах
и отчёте); read-API этих таблиц — задача 4.7.

## Инварианты

1. **История, не UPSERT** (§8.4.2): повторный расчёт (тот же `params_sig`) — новая строка
   прогона (`sessions.kind`≠`legacy`, `analyses`, `report_runs`); «последний отчёт» —
   `ORDER BY created_at DESC LIMIT 1`. **Исключение — `recordings`: там upsert**:
   одна запись = одна строка, дубль недопустим (unique по `digest`).
2. **TTL строки = TTL записи** (§8.4.3): дочерние строки уходят каскадом вместе с
   записью — `recording_store.drop_recording_rows` вызывает `DELETE /recordings/{id}`,
   строки-сироты (каталога на диске больше нет) подчищает `drop_orphan_rows` —
   **на старте приложения и в `POST /recordings` ПЕРЕД upsert** (строка умершей
   записи с тем же sha256 упёрлась бы в unique-индекс дедупа).
3. **«Записи — не 24 ч»**: `RECORDINGS_TTL_HOURS` по умолчанию `0` (не истекают);
   удаление — `DELETE /recordings/{id}` (каскад: файл + кэши + строки) или вытеснение
   по `RECORDINGS_HISTORY_LIMIT`. Результаты переживают прежний 24-часовый TTL.
4. **PHI-псевдоним** (`services/edf_phi.py`): при регистрации имя пациента и техник из
   заголовка EDF заменяются псевдонимом `Patient-<6 hex>` (B1 «человек (псевдоним)»),
   копия на диске обезличивается, исходные значения не сохраняются **нигде**
   (сайдкар, БД, ответ API). `digest` в сайдкаре/БД — sha256 **исходной загрузки**
   (до анонимизации): дедуп сравнивает повторы исходника, хеш файла на диске другой.
   Сбой обезличивания — отказ регистрации (fail closed, файл удаляется).
   Записи, загруженные до 4.4, автоматически не анонимизируются.
5. **КД — вердикт с базисом** (§2.2 `data-blocks`, concept.md §3): `kd_basis` =
   `{moment_share_x, gof_min, moment_max_nam}` — максимум момента **внутри своей
   полосы**; пороги задаёт методика (`KD_MOMENT_SHARE`/`KD_GOF_MIN`, по умолчанию
   `None`) — без них `kd_passed` = NULL («не оценено»), а не 0.
6. **Внутренние ключи результата задачи**: `run_report` кладёт точки пакета под
   `_package_points`, `summarize_band` — полный счёт имён под `name_counts` в
   агрегатах (§8.4.4 — в БД все имена, не топ-N HTML); `results_store` потребляет
   оба (`pop`) **до** записи файла задачи — в job-файле и ответе UI их нет.

## Схема, тесты, связки

- Миграции: `0002_recordings` → `0003_sessions_recording` → `0004_analyses_report`
  (определения заморожены; паритет с моделями — `tests/test_migrations.py`).
- Тесты: `tests/test_edf_phi.py` (поля заголовка, читаемость после патча),
  `tests/test_recording_store.py` (upsert/каскад/сироты), `tests/test_results_store.py`
  (шаг ②), `tests/test_report_store.py` (шаг ③, КД, полный счёт), `DELETE` — в
  `tests/test_recordings.py`.
- Лимиты: write-API — best-effort (ошибка не меняет статус задачи, правило 13
  `docs/rules/api-jobs.md`); тесты работают на изолированной tmp-БД
  (`DATABASE_URL` в `tests/conftest.py`).
