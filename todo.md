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

### Этап 2: Пользовательский UI (Frontend) — обсуждение в новой сессии
1. React/Vanilla JS frontend — 3D-визуализация диполей через Three.js
2. Загрузка EDF — drag-and-drop интерфейс
3. Настройки анализа — форма для выбора эпох, частотных диапазонов, порогов
4. 3 проекции мозга — Top/Side/Front views (axial/sagittal/coronal)
5. Анимация диполей — trajectory по времени с playback контролом
6. Brodmann Area подсветка — интерактивная карта АТЛАСА
7. Экспорт результатов — скачивание JSON/CSV

### Этап 3: Интеграция и тестирование
1. Тестовый EDF — проверка полного пайплайна на test.edf
2. Интеграция с FreeSurfer — расчёт BEM, transform
3. Docker (опционально) — если понадобится продакшен

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
