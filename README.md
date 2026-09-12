# 🧠 DipLock — Анализ ЭЭГ + токовые диполи в 3D

## 📋 Требования (финальные)

| № | Требование | Примечание |
|---|-----------|------------|
| 1 | Вход: **EDF** | Только EDF |
| 2 | Эпохи: **без overlap**, длина выбирается из `[250, 500, 750, 1000, 1250, 1500, 1750, 2000]` мс | Максимум 2000 мс |
| 3 | Авто-детекция артефактов | z-score, порог 100 µV, ICA EOG/EMG, flat-line |
| 4 | Условная модель мозга | FSAverage (шаблон FreeSurfer) |
| 5 | Частотная фильтрация | δ/θ/α/β/γ + **кастомный диапазон** + **одиночная частота** (например, 7.83 Гц, bw=0.5 Гц) |
| 6 | Анимация диполей | trajectory по времени → Three.js |
| 7 | База данных | PostgreSQL для группового анализа |
| 8 | Локализация | Анатомия (FreeSurfer aparc) + Brodmann Area (BA1–BA48) |
| 9 | 3 проекции | Top (axial) / Side (sagittal L/R) / Front (coronal) |

---

## 🚀 Структура проекта

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
│   │       └── index.html
│   ├── requirements.txt
│   ├── Dockerfile
│   ├── .env              ← НЕ коммитится (см. .env.example)
│   └── .env.example      ← шаблон конфигурации
├── data/                 ← локальные данные
│   ├── edf/              ← test.edf в репо
│   └── results/          ← результаты анализа (игнорируются)
├── docker-compose.yml
├── init_db.sql
├── setup.sh
├── .gitignore
└── README.md
```

---

## 🏃 Быстрый старт в VS Code

```bash
# Создаём структуру
bash setup.sh

# Python окружение
cd backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Авто-скачивание FSAverage (один раз, ~500 МБ)
python -c "import mne; mne.datasets.fsaverage.data_path(download=True)"

# Старт сервера
uvicorn app.main:app --reload --port 8000
# → Swagger UI: http://localhost:8000/docs
```

---

## 🐳 Запуск через Docker Compose

```bash
docker-compose up --build
# → backend: http://localhost:8000
# → Swagger UI: http://localhost:8000/docs
# → PostgreSQL: localhost:5432
# → Redis: localhost:6379
```

---

## 📤 Пример API-запроса

```bash
curl -X POST "http://localhost:8000/api/v1/analyze" \
  -F "file=@/path/to/recording.edf" \
  -F "epoch_length_ms=500" \
  -F "freq_band=alpha" \
  -F "single_freq=7.83" \
  -F "bandwidth_hz=0.5"
```

**Ответ:** JSON с `session_id`, `dipoles` (trajectory + best_fit + локализация), `surface` (mesh + BA labels), `frequency_powers`

---

## 🔧 Исправления по сравнению с исходным черновиком

1. `mne.read_labels_from_mgovt` → `mne.read_labels_from_parc` (правильный метод)
2. `brain_export.py` — функция `export_fsaverage_surface` теперь корректно использует `settings` как параметр и импорт по умолчанию
3. `mne.vertex_map` (не существует) → заменён на поиск ближайшей метки BA через координаты вершин
4. Добавлен `trimesh` в `requirements.txt` (для децимации surface-мешей)
5. `docker-compose.yml` — исправлен путь к `.env` файлу (`./backend/.env`)
6. Добавлен `setup.sh` для создания структуры папок
