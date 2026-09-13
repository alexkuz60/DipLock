# DipLock — TODO и итоги работы

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

## 📋 План на следующие этапы

### Этап 2: Пользовательский UI (Frontend) — в работе

- [x] **Фаза 0 (13.09.2026):** Pydantic-схемы ответов + `response_model` (F4), кэш меша fsaverage
      и BA-меток с ETag/304 (F6), job-API с прогрессом по этапам (F7), санитизация и очистка загрузок
      (F10), CORS 5173 (F14), `GET /api/v1/meta` (F16), gzip-сжатие ассетов
- [x] **Фаза 1 (13.09.2026):** каркас UI — левый рейл разделов, тулс-хедеры, схлопываемый правый
      сайдбар, реестр разделов, тёмная тема и токены, тултипы, Главная-заставка, «Настройки»,
      «Состояние сервера» (перенос `/init-status`), заглушки EDF / Диполи / Таблица / Групповой;
      ESLint/Prettier/Vitest/typecheck; сборка в `backend/app/static/ui`
- [x] **Фаза 2, срез 2.0 (13.09.2026):** контролы правой панели — `FieldRow`, `SegmentedControl`,
      `SelectField`, `NumberField` (границы, единицы, нормализация на blur), `CheckboxRow`,
      `StatusPill` + 15 тестов
- [x] **Фаза 2, срез 2.1 (13.09.2026):** параметры раздела EDF — zustand-срез `shared/state/edfParams.ts`
      (дефолты порогов/длин эпох/каналов из `/api/v1/meta`, выбор каналов, persist только параметров)
      и рабочая панель `sections/EdfPanel.tsx`; правило «обработка только по кнопке»: правка параметров
      не делает ни одного запроса (закрыто тестом), статус результата («не рассчитан» / «параметры
      изменены» / «актуален»), кнопка «Пересчитать предподготовку» пока неактивна и объясняет почему.
      Итого 56 тестов Vitest
- [x] **Фаза 2, срез 2.2 (13.09.2026):** загрузка записи — `POST /api/v1/recordings`
      (санитизация имени, whitelist `.edf`, лимит 200 МБ, очистка при ошибке) + read-only
      `GET /api/v1/recordings/{id}`; в UI — `sections/EdfSection.tsx` (DnD и диалог, прогресс-полоса,
      карточка метаданных записи) и protected-стор `shared/state/edfRecording.ts`. Загрузка возвращает
      только паспорт записи: обработка не запускается. Итого 87 тестов pytest
- [x] **Фаза 2, срез 2.3 (13.09.2026):** вьюер треков `sections/viewer/TrackStack.tsx` на uPlot —
      один чарт на канал, общая ось времени у нижнего трека, курсор с временем, шкала мкВ (общая/авто
      по каналу), mute/solo кликом по подписи канала, зум колесом ×1…×16 с якорем в точке курсора,
      drag — панорама; min/max-огибающая (`shared/lib/viewerMath.ts`) сохраняет пики артефактов на
      любом зуме; демо-сигнал (`shared/lib/demoSignal.ts`) для отладки без сервера; индикатор «Зум
      треков ×N» в статусбаре. Итого 82 теста Vitest, 87 pytest
- [ ] **Фаза 2, срез 2.4:** read-only `GET /recordings/{id}/signals?level=` (float32, ETag, пирамида) —
      после него вьюер покажет реальные сигналы записи вместо демо
- [ ] **Фаза 2, срез 2.5:** слои результата на фикстурах — зоны артефактов, маркеры эпох, штриховка
- [ ] **Фаза 2, срез 2.6:** кнопка «Пересчитать предподготовку» → `POST /recordings/{id}/preprocess`
      (артефакты + эпохи, без фитинга диполей) с прогрессом по этапам
- [ ] **Фаза 2, срез 2.7:** экспорт окна (PNG из canvas, CSV сигналов)
- [ ] **Фаза 3:** диполи — форма фильтров, прогресс, 3 проекции (GLB + кэш), playback траектории
- [ ] **Фаза 4:** таблица локализации — фильтры, экспорт, кросс-раздельная навигация
- [ ] **Фаза 5:** групповой анализ — read-API сессий, агрегаты по BA, тепловая карта

Изначальные требования к UI (сохранены как чек-лист): 3D-визуализация диполей через Three.js;
drag-and-drop загрузка EDF; форма настроек анализа (эпохи, диапазоны, пороги); 3 проекции
(axial/sagittal/coronal); анимация траектории с playback; интерактивная карта полей Бродмана;
экспорт JSON/CSV. Подробности (экраны, принципы, зум-пирамида, дорожная карта) — `docs/ui.md`.

### Этап 3: Интеграция и тестирование
1. Тестовый EDF — проверка полного пайплайна на `data/edf/test.edf` (маркер `integration`)
2. Интеграция с FreeSurfer — расчёт BEM, transform
3. CI: pytest + Vitest + сборка UI; alembic-миграции, ruff/mypy, генерация TS-типов из OpenAPI
4. Docker (опционально) — если понадобится продакшен

## 🐞 Находки живого прогона пайплайна (13.09.2026, см. `audit.md` §7.7)

Прогон полного `/jobs`-пайплайна на `data/edf/test.edf` прошёл «успешно», но **диполей нет**:

- [ ] **F17 (P0):** `mne.fit_dipole` в MNE 1.13.2 возвращает кортеж `(dipoles, residual)` →
      `AttributeError: 'tuple' object has no attribute 'pos'` на каждой эпохе. Распаковать кортеж,
      закрыть контракт тестом (unit с кортежем + `integration` с `DIPOLE_FIT_MAX_EPOCHS=1`)
- [ ] **F18 (P0):** ошибки фитинга проглатываются поштучно → задача `succeeded` с нулевым
      результатом; нужен агрегат ошибок в контракте и предупреждение в UI
- [ ] **F19 (P0, Фаза 3):** стоимость — 5.4 с на точку фитинга и 0.27 с на точку локализации
      (том `aparc.a2009s+aseg` перечитывается каждый вызов) → дефолты дают ≈20 ч на 130 с ЭЭГ.
      Нужны: оценка времени до запуска, превью-режим, `n_jobs`, кэш BEM и aseg, дробный прогресс
- [ ] **F20 (P1, важно для Фазы 2):** flat-line ловит 222 ложных срабатывания из 290 — критерий
      «|x| < 5 мкВ дольше 200 мс» на band-passed сигнале; заменить на оконный «почти константа»
- [ ] **F21 (P1):** в БД пишутся только `sessions` (`epochs=0`, `dipoles=0`) — F5 в действии
- [ ] Мелочь: в `README.md`/`AGENTS.md` заменить `curl :8000/...` на `curl http://localhost:8000/...`
      (в текущем окружении curl без схемы не работает)

## 🐳 ОТЛОЖЕНО (по решению владельца — только локальная разработка)

### Docker: починить монтирование FSAverage-данных
- [ ] **Проблема (из аудита):** `.env` содержит пути `/home/alexkuz60/mne_data/...`,
      которых нет внутри docker-контейнера. `docker compose up` упадёт на FSAverage-данных.
- [ ] Смонтировать `~/mne_data` томом в `docker-compose.yml`
- [ ] Или автоматически скачивать fsaverage при старте контейнера
- [ ] Упростить `.env` для контейнерного запуска (не хардкодить `/home/alexkuz60/...`)
- [ ] Добавить `HEALTHCHECK` в `Dockerfile`
- [ ] Решить вопрос с неиспользуемым сервисом `redis` в `docker-compose.yml`

## 🎯 Статус: ✅ Готово к использованию для локальной разработки

Сервер: uvicorn app.main:app --host 0.0.0.0 --port 8000
URL: http://localhost:8000
