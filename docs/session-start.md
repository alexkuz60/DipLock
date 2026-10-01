# Памятка агенту: с чего начинать сессию

> Обновляется в конце крупных срезов (последнее — **01.10.2026**: раздел «Итоги» (автоотчёт
> `kind=report`, HTML `mne.Report` в iframe) + заглушки «ЕмоЛаб»/«Нейроаудио», реестр 12
> разделов и хоткеи 1…9; ранее тот же день — п.5 (`flat_line` на широкополосном), пересмотр
> вердикта п.4 (авто-длина эпох), «Тестовый EDF» (e2e пайплайна);
> ранее — **29.09.2026**: 3.5 (3D — Niivue, контур головы `seghead`, совместный курсор),
> визуализация препроцессинга 3 (независимые отмены чистки + метрики L1/L3/L4/L5); фаза B,
> 3.3, 3.4, 4.1, 4.2).
> Живой список задач — `todo.md`, журнал закрытого — `docs/history.md`, правила — `AGENTS.md`.

## Чек-лист старта

1. `AGENTS.md` читается автоматически: команды, конвенции, «бэкенд-/фронтенд-ловушки», карта
   документации. Не начинать с нуля — сначала состояние.
2. Уточнить состояние: `cat todo.md` (что открыто), `git --no-pager log --oneline -5` и
   `git status --short` (незакоммиченное = прерванная работа чужой сессии — разобраться).
3. Поднять сервисы:
   - backend: `cd backend && venv/bin/uvicorn app.main:app --reload --port 8000`;
   - frontend: `cd frontend && npm run dev` (5173) и/или `npm run build:watch` — правки UI на
     **:8000/ui/ видны только после сборки** (`npm run build` → `backend/app/static/ui`).
4. Перед закрытием среза: `ruff`/`mypy`/`pytest` + `eslint`/`tsc`/`Vitest` + `npm run build`;
   правило → `docs/rules/` (+ строка в карте `AGENTS.md`), тест → рядом с кодом, закрытое →
   `docs/history.md` (дословно), открытое → `todo.md` (`docs/rules/docs.md`).

## Состояние на конец 01.10.2026 (п.5, вердикт п.4 и «Тестовый EDF» закрыты)

- **01.10.2026 — три пункта одного разреза** (факты, замеры и находка — `docs/history.md`,
  записи 01.10.2026):
  * **п.5** — `flat_line`/`clipping` считаются на **широкополосном** сигнале
    (`detect_artifacts(flat_raw=…)` + подъём broadband prepared в `preprocess._detect`);
    гипотеза дрейфа отклонена, все 1852 δ-зоны на 4 записях ложные; регресс п.5 есть и в
    e2e (`flat_line` на δ test.edf = 0, было 293);
  * **пересмотр вердикта п.4 (авто-длина эпох)** — замер `epoch_survival.py` на «чистой»
    `test.edf`: δ 2000 мс → **71% (46/65), 92 с** против 4000 мс → **56% (18/32), 72 с**;
    «короче для высоких» подтверждён (+16…+23 п.п.), **«длиннее для низких» отклонён
    окончательно** (обе записи — чистая и клиническая); правило §8.3 «≥2 периодов» —
    предупреждением при выборе длины, а не авто-подстановкой (4000 мс не добавляем).
    К реализации — направление «короче для высоких» (механику уточнить);
  * **«Тестовый EDF» закрыт** — e2e `backend/tests/test_pipeline_e2e.py` (маркер
    `integration`): все стадии `/analyze`, job-путь и preprocess-цепочка на реальном
    `test.edf` (хронометраж 106.7/114.2/1.8 с); **найден и починен баг `n_epochs_total`**
    (`len(.events)` → `len(drop_log)`: MNE убирает отброшенные из `.events`, `n_epochs_dropped`
    был вечно 0). Фикстура `isolated_io` переехала в `tests/conftest.py`.

## Состояние на конец 29.09.2026 (3.5 и визуализация препроцессинга 3 закрыты)

- **3.5 (29.09.2026)**: 3D-вид **Niivue** (`@niivue/niivue` 0.69) — тома отдаются сырыми
  (`GET /surface/mri/volume/{name}`, белый список в `services/mri_volumes.py`, ассет `volumes`),
  affine T1 в `/meta` (`mri_volumes.affine`); диполи — connectome-узлами в мировых мм (таблица
  `FSAVERAGE_T1_AFFINE` под защитой `test_real_t1_affine_matches_frontend_table`). Реальный
  **контур головы** из `seghead.mgz` (ключ `head` в npz-кэше контуров, `CONTOUR_VERSION`=3;
  `null` = ассета нет → условная фикстура, `[]` = на срезе пусто). **Совместный курсор**
  (`projectionCursor` — сессия, не персистится; оверлей `ProjectionCursor.tsx` поверх слоёв).
  Переключатель «Проекции / 3D» — `view3d` (отрисовка, расчёт не трогает). Правила —
  `docs/rules/atlas-mri.md` (новый раздел), факт — `docs/history.md` 29.09.2026.
- **Визуализация препроцессинга 3 (29.09.2026)**: зоны вклада чистки
  (`services/clean_metrics.py`, robust-пороги в `core/config.py`: `clean_zone_mad_k`,
  `clean_zone_min/merge_gap_ms`), отмены по серверным id (`CleanSpec.exclude_zone_ids` —
  часть ключа кэша; восстановление сэмплов из сырого сигнала в `apply_cleaning`; форма
  `exclude_zone_ids` в preprocess и query signals, слой `band` — 400), метрики потерь
  L1/L3/L4/L5 в отчёте стадии (`CleanReportOut.zones/loss`; L5 — `ica_components | diff`).
  UI: чекбоксы зон и таблица метрик в «Фильтр и референс» (`cleanExcludeZoneIds` в
  `STAGE_PARAM_KEYS.filter`), подсветка отменённых зон — только на слое `diff`
  (`CleanZoneLayer`). Правила — `docs/rules/artifacts.md`, факт — `docs/history.md` 29.09.2026.
- **4.2 (29.09.2026)**: схему БД создаёт и меняет **только alembic** (`backend/alembic/`,
  ревизия `0001` терпит старые файлы и заменяет `_add_missing_columns`; `init_db` =
  `upgrade head` в `asyncio.to_thread`; индексы N37, `trajectory_json` = jsonb+GIN в PG;
  страж паритета моделей и миграций — `tests/test_migrations.py`). TS-типы генерируются:
  `venv/bin/python -m scripts.export_openapi` → `frontend/src/shared/api/openapi.json` →
  `npm run gen:api` → `schema.d.ts`; `types.ts` — алиасы `components['schemas']`, стражи —
  pytest (`test_openapi_json_is_up_to_date`) и CI (`gen:api` + `git diff --exit-code`).
  Факт — `docs/history.md` 29.09.2026.

- **Фаза B (29.09.2026)**: `services/prepared_persist.py` — дисковый персист подготовленного
  массива по полосе (ключ `recording_id + band_key + notch + референс`, контейнер `DPP1`,
  float32 вольты, путь `cache_dir/prepared/{id}/{band_key}-{sig}.bin`); слой **`band`** в пирамиде
  (`GET …/signals?layer=band&band_key=…`, свой ETag/файл, 400 на числовую полосу/очистку);
  UI: пункт «По полосе» + селект «Полоса слоя» (параметр `signalBandKey`, вне `STAGE_PARAM_KEYS`).
  Инварианты — `docs/rules/data-and-caches.md` п.16 (обновлён), факт — `docs/history.md` 29.09.2026.
- **3.3 (29.09.2026)**: дедуп `spectrum_signature` — дубль из аудита (строки 359/384 в `7625de6`)
  удалён ещё в `09b403d` (Этап 1.2); закрыто тестом-стражом
  `test_compute_spectrum_computes_signature_once`. Факт — `docs/history.md` 29.09.2026.
- **3.4 (29.09.2026)**: семь SVG-слоёв вынесены в `dipoles/MriProjectionLayers.tsx` (перенос
  дословно, хуков в слоях нет): `MriProjection.tsx` 770 → 520 строк. Валидация п.6 — lint/typecheck
  и Vitest 854 зелёные **без правок тестов**. Факт — `docs/history.md` 29.09.2026.
- **4.1 (29.09.2026)**: `EpochRecord` — колонки = 7 полос `freq_bands` (терялись `delta_theta`,
  `gamma`, `high_gamma`), запись собирается из конфига, старые файлы БД догоняет `init_db`
  (ручная правка до alembic). Тесты: pytest 542/550. Факт — `docs/history.md` 29.09.2026.
- **Фаза A закрыта (28.09.2026)**: `freq_bands` = 7 октавных (δ 0.5–2 … γ-high 64–128),
  `functional_bands` = 6 (μ/σ/κ/τ/λ/ψ, `<optgroup>`); **ключи полос стабильны = адрес результатов,
  не переименовывать** (и адрес персиста — тоже).
- **Отклонения от плана, которые нельзя откатывать вслепую**: Найквист−2 Гц (`nyquist_ceiling_hz`),
  ось PSD = сетка ∩ полоса фильтра, дефолт расчёта 0.5–128 (объяснения в `docs/history.md` 28.09.2026).
- **Фаза C — только инварианты**: `docs/rules/dipoles.md` п.6 (`band_key` для пакетного расчёта;
  вход готов — `prepared_persist.prepared_array` даёт массив без перечитывания EDF).
- Числа: **916 Vitest / 594 pytest** (без `integration` — 578), ruff/mypy (`app alembic`)/eslint/tsc
  чисты, бандл собран в `backend/app/static/ui` (не коммитится — `.gitignore`).

## Следующий шаг (порядок из todo.md)

1. **Ручной прогон на живом сервере**: uvicorn `--reload` + `build:watch` — 3D-вид (требует
   WebGL), контур головы, синхронизация курсора; стадия «Фильтр и референс» — зоны вклада,
   отмены и метрики потерь на реальной записи (тысячи строк в легенде зон не рисуем — зон
   должно быть мало).
2. Далее из todo.md: «FreeSurfer» (BEM/transform на живой установке), 3.10+ (точный профиль
   `mne.fit_dipole`), п.4 «авто-длина эпох» (вердикт зафиксирован 01.10.2026 — реализуется
   только направление «короче для высоких», механику уточнить).

## Повторявшиеся ловушки

- «Правка не работает» на :8000 → не собран фронт (`build:watch`); API «не видит» правки →
  uvicorn без `--reload`; залипший трансформ-кэш Vite → перезапустить `npm run dev`.
- Правило раздела: правка параметра **не запускает расчёт** (считает кнопка), подпись печатает
  числа полосы, а не название ритма.
- Файлы задач и кэши результатов переживают перезагрузку и показывают цифры прошлого конфига —
  после смены сетки/конфига пересчитывать запись («Бэкенд-ловушки» в `AGENTS.md`).
