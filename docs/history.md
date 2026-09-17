# История работ DipLock

> Журнал выполненных работ: сюда переносится всё закрытое из `todo.md` (дословно),
> чтобы текущий список задач оставался коротким. Новые записи — сверху, датой среза.

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
