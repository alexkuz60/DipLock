# Структура кода DipLock

> Дерево модулей с комментариями — перенесено дословно из `AGENTS.md` 15.10.2026
> (правило `docs/rules/docs.md` п.1/п.4: `AGENTS.md` — вход ≤15 КБ).
> Назначение шага пайплайна — докстринг модуля; правила по темам — `docs/rules/*`.


```
backend/app/
├── main.py            # FastAPI entry: CORS (5173), gzip, раздача /ui (сборка frontend) и /legacy
├── core/config.py     # Pydantic-settings — ЕДИНЫЙ источник конфига
├── api/               # роуты + адаптеры HTTP (этап 3)
│   ├── routes.py      # 78 роутов = 73 уникальных пути (инвентарь — `docs/rules/api-jobs.md`)
│   ├── assets.py      # ETag/304: единственный помощник отдачи ассетов (A2)
│   ├── params.py      # формы → параметры сервисов, 400 с текстом для UI (A1)
│   ├── recording_jobs.py # задачи записи: старт 202, статус, результат (A1)
│   ├── consilium.py   # Консилиум: форма и контракт, работа — services/consilium (Т1)
│   ├── llm_router.py  # модельный роутер ИИ: провайдеры API + probe (10.10.2026)
│   └── uploads.py     # приём EDF: имя, размер, sha256 (F10)
├── schemas/           # Pydantic-контракт ответов (OpenAPI → TS-типы UI)
├── models/db.py       # SQLAlchemy модели (Session, Epoch, Dipole): пишется только legacy-анализ
├── utils/             # brain_export.py, versions.py, png.py (энкодер PNG: срезы, топокарты),
│                      # marching_squares.py (изолинии маски), robust.py (медиана/MAD детекторов)
├── services/          # КАЖДЫЙ модуль = один шаг пайплайна
│   ├── edf_loader.py  # read_raw_edf → pick/montage/reference/filter
│   ├── artifact_detector.py, artifact_cleaner.py, epoch_segmenter.py, bandpass_filter.py
│   ├── cardio.py      # кардио без ECG-канала: единый QRS → зоны ecg, прокси ICA, ряд ЧСС (трек пульса)
│   ├── filter_design.py # дизайн фильтра: FIR/IIR, переходные полосы, буферы края, АЧХ (2.5)
│   ├── dipole_fitter.py     # точный фитинг (эксперим.): mne.fit_dipole по эпохам, цена в /meta
│   ├── recordings.py      # реестр записей просмотра: паспорт, TTL, дедуп (2.2)
│   ├── edf_phi.py     # PHI-псевдоним заголовка EDF при регистрации (4.4, шаг ①)
│   ├── recording_store.py # строки recordings: upsert, каскад «TTL строки = TTL записи» (4.4)
│   ├── results_store.py   # write-API задач UI в БД: sessions/epochs/dipoles + analyses/report_* (4.4)
│   ├── recording_signals.py # пирамида сигналов вьюера: огибающая ×1…×16, кэш (2.5)
│   ├── preprocess.py      # стадии предподготовки записи: filter/artifacts/epochs (2.7)
│   ├── edf_events.py      # события записи: аннотации EDF+ и маркеры стим-каналов (2.7)
│   ├── evoked.py          # ERP-усреднение по событиям: задача kind=evoked (2.7)
│   ├── spectral.py        # спектр δ…γ (Welch/multitaper + 1/f-фит specparam) + топокарты PNG, кэш + ETag (3.4)
│   ├── spectrogram.py     # спектрограмма канала: STFT → сетка дБ (DPS2), кэш + ETag (5)
│   ├── channel_mix.py     # виртуальные каналы «ЭЭГ»: миксы групп 10-20 из паспорта записи (5+)
│   ├── audio_render/      # «Нейромузыка» (эксперимент): ядро ×128, варианты Экспресс/Монтаж (rows.py — 4 ряда 10-20), 3D-bake (bake.py), радар «Эмо» (emo_radar.py — FFT-кадры микса), WAV+sidecar (docs/rules/neuromusic.md)
│   ├── audio_ir.py        # IR-ассеты реверберации плеера: pyroomacoustics → cache/ir/ + ETag (spatial-audio)
│   ├── dipole_scanner.py  # быстрый расчёт: сетка узлов, сферическая модель (3.4)
│   ├── eloreta.py         # eLORETA пик/ROI одной эпохи: forward+inverse MNE (остаток B9)
│   ├── compare.py         # дифференциальный анализ двух записей (B9): дельты B − A, FDR/бутстрап, кластерный тест MNE, карты разности
│   ├── report.py          # автоотчёт «Итоги»: MNE.Report (часть 1) + пакет диполей по полосам (§3.9) + тема (THEME_CSS/THEME_JS)
│   ├── session_bundle.py  # пакет сессии (zip: EDF+манифест | BIDS), CSV-экспорт диполей (4.6)
│   ├── group_reports.py   # отчёты «Итогов» по групповым анализам (Тип 1 «Сравнение», Тип 2 «Группа», §3.9.8)
│   ├── roi.py             # ROI-анализ (4.5): агрегат «строка ROI × полосы» из точек пакета — один источник для отчёта и вкладки UI
│   ├── analysis_pipeline.py # пайплайн файлового анализа (/analyze, /jobs) + запись в БД (A1)
│   ├── cache_store.py     # единый дисковый кэш: путь/чтение/атомарная запись/очистка (этап 2)
│   ├── journal.py         # журнал шагов пайплайнов: GET /journal (этап 5)
│   ├── analytics_db.py    # SQLite-проекция журнала: steps + recording_id, суммы/медианы/топ SQL (4.3)
│   ├── mains.py           # сигнал сетевого фона: уровни L1 и вырезанная notch-компонентная
│   ├── covariance_qc.py   # QC-слой ковариации: λ/% дисперсии + heatmap/топокарты ПК «до/после» (п.6)
│   ├── job_store.py       # файл задачи на диске: история, результат и run manifest (A8, 4.6)
│   ├── run_manifest.py    # отпечаток прогона: версии среды + ассеты + params_sig (4.6)
│   ├── orphans.py         # обход сирот при старте (A6) + LRU-квота кэша (CACHE_QUOTA_MB, 4.6)
│   ├── asset_versions.py  # единый отпечаток версий ассетов (A7)
│   ├── prepared_signal.py # RAM-кэш подготовленного сигнала: EDF один раз на набор параметров (A4)
│   ├── prepared_persist.py # дисковый персист массива по полосе: ключ band_key+notch+референс (Фаза B)
│   ├── job_manager.py     # фоновые задачи: этапы, прогресс эпох, семафор (F7)
│   ├── server_control.py  # перезапуск бэкенд из UI: guard'ы + os.execv (POST /server/restart)
│   ├── gpu.py           # локальный ресурс: автоопределение GPU/CuPy + тумблер «Использовать GPU» → n_jobs='cuda' (GET/PUT /resource)
│   ├── llm_router.py      # модельный роутер ИИ: провайдеры внешних API (openai/anthropic), маршруты chat/transcribe, ключи маскируются
│   ├── surface_cache.py   # кэш меша/BA на диске + ETag/304 (F6)
│   ├── fsaverage_assets.py # BEM/transform fsaverage: файл → кэш → расчёт MNE (FreeSurfer)
│   ├── mri_slices.py      # том T1 на MNI-сетке, срез картинкой (PNG) + ETag/304 (3.2)
│   └── atlas_contours.py  # контуры структур и полей Бродмана на срезе (вектор, ETag) (3.9)
backend/scripts/       # dedupe_recordings.py (чистка дублей в data/edf),
                       # build_atlas_contours.py (прогрев кэша контуров, 3.9),
                       # build_audio_ir.py (прогрев кэша IR «Нейромузыки», spatial-audio),
                       # export_openapi.py (выгрузка openapi.json для gen:api, 4.2)
backend/alembic/       # миграции схемы БД: env.py (URL из settings/движка), versions/ (0001)
backend/alembic.ini    # конфиг alembic (запуск из backend/)
backend/pyproject.toml # конфиг ruff + mypy
frontend/              # UI (Vite+React+TS), сборка → backend/app/static/ui
data/                  # локальные данные (edf/results/cache) — НЕ коммитить
docs/ui.md             # спецификация UI и дорожная карта фаз
.github/workflows/     # CI: ruff+mypy+pytest и lint+tsc+Vitest+build
```

