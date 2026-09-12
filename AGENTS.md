# AGENTS.md — инструкции для ИИ-агентов (DipLock)

> Файл читается автоматически ИИ-агентами (Copilot, Cursor, Codex, Claude Code и др.).
> Обзор полной архитектуры: `audit.md`, `README.md`. Держите этот файл компактным.

## Обзор

FastAPI-бекенд для анализа ЭЭГ: EDF → артефакты → эпохи → фильтры → диполи → 3D-локализация.
Стек: **Python 3.12, FastAPI, MNE-Python, SQLAlchemy (SQLite/dev, PostgreSQL/prod), Docker**.
Научные данные FSAverage (FreeSurfer) лежат локально в `~/mne_data/`.

## Команды

```bash
# Установка зависимостей
cd backend && python -m venv venv
venv/bin/pip install -r requirements.txt

# Запуск сервера (рабочая директория — backend/)
cd backend && venv/bin/uvicorn app.main:app --reload --port 8000

# Проверка
curl :8000/health       # {"status":"ok",...}
curl :8000/init-status  # готовность MNE/БД/fsaverage
# Swagger: http://localhost:8000/docs
```

## Структура

```
backend/app/
├── main.py            # FastAPI entry, CORS, static, /init-status
├── core/config.py     # Pydantic-settings — ЕДИНЫЙ источник конфига
├── api/routes.py      # /analyze, /brain-surface, /brodmann-labels
├── services/          # КАЖДЫЙ модуль = один шаг пайплайна
│   ├── edf_loader.py  # read_raw_edf → pick/montage/reference/filter
│   ├── artifact_detector.py
│   ├── epoch_segmenter.py
│   ├── bandpass_filter.py
│   └── dipole_fitter.py
├── models/db.py       # SQLAlchemy модели (Session, Epoch, Dipole)
└── utils/brain_export.py
data/                  # локальные данные (edf/results) — НЕ коммитить linuxы
```

## Конвенции

- **DRY**: частотные диапазоны (`freq_bands`) и длины эпох берите из `core/config.py`,
  не дублируйте в сервисах.
- **Не хардкодить пути** `/home/...` — только из `settings`/окружения.
- Типизация: все подписи функций — с аннотациями типов; докстринги на русском.
- **Async**: НЕ выполняйте тяжёлые MNE/CPU-операции напрямую в `async def` —
  используйте `fastapi.concurrency.run_in_executor` или очередь задач.
- Один шаг пайплайна = один модуль в `services/`, без смешивания ответственности.
- Кэшируйте ресурсоёмкие объекты (поверхности FSAverage, transform, labels).

## НЕ коммитить

- `venv/`, `__pycache__/`, `.env`, `data/results/`, `*.db` — см. `.gitignore`.
- `.env` содержит локальные пути/настройки — вместо него есть `.env.example`.

## Тесты

Специализированный фреймворк ещё не подключён — добавить `pytest`.
Проверка после изменений: сервер стартует, `/health` и `/init-status` → 200.

## Правила безопасности

- Не передавать в `head_to_mni` путь-строку вместо `mne.Transform` (использовать `mne.read_trans`).
- CORS: не комбинировать `allow_origins=["*"]` с `allow_credentials=True`.
- Валидировать размер загружаемых EDF-файлов.