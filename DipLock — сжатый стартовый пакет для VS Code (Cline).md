# 🧠 **DipLock** — Анализ ЭЭГ + токовые диполи в 3D

## Требования (финальные)

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

## Структура проекта DipLock

```
dip-lock/
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
│   │   │   ├── dipole_fitter.py
│   │   │   └── brain_export.py
│   │   ├── models/
│   │   │   ├── __init__.py
│   │   │   └── db.py
│   │   └── utils/
│   │       ├── __init__.py
│   │       └── brain_export.py
│   ├── requirements.txt
│   ├── Dockerfile
│   └── .env
├── docker-compose.yml
├── init_db.sql
└── README.md
```

---

## 1. shell-скрипт для создания структуры

```bash
#!/bin/bash
# Сохраните как setup.sh и выполните: bash setup.sh
# Или выполните по шагам в терминале VS Code

mkdir -p dip-lock/backend/app/{core,api,services,models,utils}
mkdir -p dip-lock/backend/app/core
mkdir -p dip-lock/backend/app/api
mkdir -p dip-lock/backend/app/services
mkdir -p dip-lock/backend/app/models
mkdir -p dip-lock/backend/app/utils

# Создаём __init__.py
touch dip-lock/backend/app/__init__.py
touch dip-lock/backend/app/core/__init__.py
touch dip-lock/backend/app/api/__init__.py
touch dip-lock/backend/app/services/__init__.py
touch dip-lock/backend/app/models/__init__.py
touch dip-lock/backend/app/utils/__init__.py
```

---

## 2. backend/requirements.txt

```txt
fastapi>=0.115.0
uvicorn[standard]>=0.30.0
mne>=1.7.0
numpy>=2.0.0
scipy>=1.14.0
sqlalchemy>=2.0.0
asyncpg>=0.29.0
alembic>=1.13.0
psycopg2-binary>=2.9.0
python-multipart>=0.0.10
pydantic-settings>=2.5.0
```

---

## 3. backend/app/core/config.py

```python
"""Настройки DipLock через Pydantic Settings."""
from pydantic_settings import BaseSettings, Field
from typing import Dict, List


class Settings(BaseSettings):
    # FastAPI
    app_name: str = "DipLock"
    debug: bool = True

    # База данных
    database_url: str = Field(
        default="postgresql+asyncpg://neurodipole:neurodipole@db:5432/diplock",
        env="DATABASE_URL",
    )

    # FSAverage
    subjects_dir: str = Field(
        default="/app/data/fsaverage",
        env="SUBJECTS_DIR",
    )
    fsaverage_trans: str = Field(
        default="/app/data/fsaverage/fsaverage-trans.fif",
        env="FSAVERAGE_TRANS",
    )

    # Артефакты
    z_score_threshold: float = 5.0
    peak_to_peak_threshold_uv: float = 100.0
    flat_line_threshold_uv: float = 5.0
    flat_line_min_duration_ms: float = 200.0

    # Нарезка эпох (без overlap)
    epoch_lengths_ms: List[float] = [250, 500, 750, 1000, 1250, 1500, 1750, 2000]
    default_epoch_length_ms: float = 2000.0

    # Частотные диапазоны
    freq_bands: Dict[str, tuple] = {
        "delta": (1, 4),
        "theta": (4, 8),
        "alpha": (8, 13),
        "beta": (13, 30),
        "gamma": (30, 40),
    }
    default_single_freq_bandwidth_hz: float = 0.5  # для одиночной частоты

    # 10-20 каналы
    standard_channels: List[str] = [
        "Fp1", "Fp2", "F3", "F4", "C3", "C4",
        "P3", "P4", "O1", "O2", "F7", "F8",
        "T7", "T8", "P7", "P8", "Fz", "Cz",
        "Pz", "Oz",
    ]

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
```

---

## 4. backend/app/main.py

```python
"""DipLock FastAPI entry-point."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router as api_router

app = FastAPI(
    title="DipLock",
    description="Анализ ЭЭГ и расчёт токовых диполей в 3D",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api/v1")


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "dip-lock-backend"}
```

---

## 5. backend/app/api/routes.py

```python
"""REST API эндпоинты."""
from fastapi import APIRouter, UploadFile, File, Form
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional, List

router = APIRouter()


@router.post("/analyze")
async def analyze_eeg(
    # === Файл ===
    file: UploadFile = File(...),

    # === Нарезка эпох ===
    epoch_length_ms: float = Form(2000.0),

    # === Частотная фильтрация ===
    freq_band: str = Form("all"),                    # "all", "delta", "theta" ...
    custom_min_freq: Optional[float] = Form(None),   # кастомный диапазон
    custom_max_freq: Optional[float] = Form(None),
    single_freq: Optional[float] = Form(None),       # одиночная частота, напр. 7.83

    # === Артефакты ===
    run_ica: bool = Form(True),

    # === Артефакт-детекция пороги ===
    z_threshold: float = Form(5.0),
    pp_threshold_uv: float = Form(100.0),
):
    """Полный пайплайн: EDF → артефакты → эпохи → фильтр → диполи → локализация."""
    from app.services.edf_loader import load_edf
    from app.services.artifact_detector import detect_artifacts
    from app.services.epoch_segmenter import segment_epochs
    from app.services.bandpass_filter import apply_band_filter, compute_band_power
    from app.services.dipole_fitter import fit_dipoles_for_epochs, localize_dipoles
    from app.utils.brain_export import export_fsaverage_surface
    from app.core.config import settings
    import uuid, shutil, os

    session_id = str(uuid.uuid4())
    upload_dir = f"/tmp/diplock_uploads/{session_id}"
    os.makedirs(upload_dir, exist_ok=True)
    tmp_path = os.path.join(upload_dir, file.filename)
    shutil.copyfileobj(file.file, open(tmp_path, "wb"))

    # 1. Загрузка
    raw = load_edf(tmp_path, settings.standard_channels)

    # 2. Артефакты
    annotations, artifact_stats = detect_artifacts(raw, settings, z_threshold, pp_threshold_uv)

    # 3. Нарезка (без overlap)
    epochs = segment_epochs(
        raw, annotations,
        epoch_length_ms=epoch_length_ms,
    )

    # 4. Фильтр
    if freq_band != "all" or single_freq is not None:
        epochs = apply_band_filter(
            epochs, freq_band,
            custom_min=custom_min_freq,
            custom_max=custom_max_freq,
            single_freq=single_freq,
            bandwidth_hz=settings.default_single_freq_bandwidth_hz,
        )

    # 5. Power
    freq_powers = compute_band_power(epochs, settings.freq_bands)

    # 6. Диполи
    dipoles = fit_dipoles_for_epochs(epochs, settings, freq_bands=freq_powers)

    # 7. Локализация
    dipoles = localize_dipoles(dipoles, settings)

    # 8. Surface (кешируем)
    surface = export_fsaverage_surface(settings)

    return JSONResponse({
        "session_id": session_id,
        "filename": file.filename,
        "n_channels": raw.info["nchan"],
        "sfreq": raw.info["sfreq"],
        "duration_sec": round(len(raw) / raw.info["sfreq"], 2),
        "epoch_length_ms": epoch_length_ms,
        "freq_band": freq_band,
        "n_epochs_total": len(epochs),
        "n_epochs_used": len(epochs),
        "n_artifacts": artifact_stats["total"],
        "artifact_types": artifact_stats["by_type"],
        "frequency_powers": freq_powers,
        "surface": surface,
        "dipoles": dipoles,
    })


@router.get("/brain-surface")
async def get_brain_surface():
    from app.utils.brain_export import export_fsaverage_surface
    from app.core.config import settings
    return export_fsaverage_surface(settings)


@router.get("/brodmann-labels")
async def get_brodmann_labels():
    from app.core.config import settings
    import mne, os
    if not os.path.isdir(f"{settings.subjects_dir}/fsaverage"):
        mne.datasets.fsaverage.data_path()
    labels = mne.read_labels_from_mgovt(
        "fsaverage", parc="aparc.a2009s",
        subjects_dir=settings.subjects_dir,
    )
    ba = [l.name for l in labels if l.name.startswith("BA")]
    return {"brodmann_areas": ba}
```

---

## 6. backend/app/services/edf_loader.py

```python
"""Загрузка EDF + монтаж 10-20 + фильтр."""
import mne
from typing import List


def load_edf(filepath: str, channel_names: List[str], l_freq: float = 1.0, h_freq: float = 40.0) -> mne.io.BaseRaw:
    raw = mne.io.read_raw_edf(filepath, preload=True, stim_channel=False)

    available = [ch for ch in channel_names if ch in raw.ch_names]
    if not available:
        raise ValueError(
            f"Ни один из стандартных каналов не найден. "
            f"Доступные в EDF: {raw.ch_names}"
        )

    raw.pick(available)
    raw.set_montage("standard_1020")
    raw.set_eeg_reference("average", projection=True)
    raw.filter(l_freq, h_freq, fir_design="firwin")
    raw.resample(min(raw.info["sfreq"], 500.0), events="auto")

    return raw
```

---

## 7. backend/app/services/artifact_detector.py

```python
"""Авто-детекция артефактов: z-score, порог, ICA, flat-line."""
import numpy as np
import mne
from scipy import ndimage
from typing import Tuple, Dict
from app.core.config import Settings


def detect_artifacts(raw, settings, z_threshold=5.0, pp_threshold_uv=100.0) -> Tuple[mne.Annotations, dict]:
    annotations = mne.Annotations(onset=[], duration=[], description=[])
    stats = {"zscore_outlier": 0, "peak_to_peak": 0, "flat_line": 0, "ica_eog": 0}

    data = raw.get_data()
    sfreq = raw.info["sfreq"]

    # 1. Z-score
    for i, ch in enumerate(raw.ch_names):
        ch_data = data[i]
        std = np.std(ch_data)
        if std == 0:
            continue
        z = np.abs((ch_data - ch_data.mean()) / std)
        bad = z > z_threshold
        if bad.any():
            lab, nf = ndimage.label(bad)
            for r in range(1, nf + 1):
                idx = np.where(lab == r)[0]
                if len(idx) >= 3:
                    annotations += mne.Annotations(
                        onset=[idx[0] / sfreq],
                        duration=[len(idx) / sfreq],
                        description=["zscore_outlier"],
                    )
                    stats["zscore_outlier"] += 1

    # 2. Peak-to-peak (скользящее окно 2 сек)
    win = int(2.0 * sfreq)
    for w_start in range(0, data.shape[1] - win, win // 2):
        pp = np.ptp(data[:, w_start:w_start + win], axis=1)
        if np.any(pp > pp_threshold_uv * 1e-6):
            center = (w_start + win // 2) / sfreq
            annotations += mne.Annotations(
                onset=[center], duration=[win / sfreq],
                description=["peak_to_peak"],
            )
            stats["peak_to_peak"] += 1

    # 3. Flat-line
    flat_min = int(settings.flat_line_min_duration_ms / 1000.0 * sfreq)
    for i, ch in enumerate(raw.ch_names):
        flat = np.abs(data[i]) < (settings.flat_line_threshold_uv * 1e-6)
        lab, nf = ndimage.label(flat)
        for r in range(1, nf + 1):
            idx = np.where(lab == r)[0]
            if len(idx) >= flat_min:
                annotations += mne.Annotations(
                    onset=[idx[0] / sfreq],
                    duration=[len(idx) / sfreq],
                    description=["flat_line"],
                )
                stats["flat_line"] += 1

    # 4. ICA EOG
    eog_like = [ch for ch in raw.ch_names if "eog" in ch.lower()]
    if eog_like:
        try:
            ica = mne.preprocessing.ICA(n_components=min(18, len(raw.ch_names)), random_state=42, max_iter="auto")
            ica.fit(raw)
            bads, _ = ica.find_bads_eog(raw)
            stats["ica_eog"] = len(bads)
        except Exception:
            pass

    total = sum(stats.values())
    return annotations, {"total": total, "by_type": stats}
```

---

## 8. backend/app/services/epoch_segmenter.py
**ИЗМЕНЕНО: без overlap, выбор длины из списка**

```python
"""Нарезка эпох БЕЗ overlap. Длина выбирается из списка: [250, 500, ..., 2000] мс."""
import mne
import numpy as np


def segment_epochs(
    raw: mne.io.BaseRaw,
    artifact_annotations: mne.Annotations,
    epoch_length_ms: float = 2000.0,
    reject_threshold_uv: float = 150.0,
) -> mne.Epochs:
    """Разбивает сессию на эпохи без наложения (non-overlapping)."""
    valid_lengths = [250, 500, 750, 1000, 1250, 1500, 1750, 2000]
    if epoch_length_ms not in valid_lengths:
        raise ValueError(f"Длина эпохи {epoch_length_ms} мс не в списке: {valid_lengths}")

    raw.set_annotations(artifact_annotations)
    epoch_length_sec = epoch_length_ms / 1000.0

    # События без overlap
    events = mne.make_fixed_length_events(
        raw, duration=epoch_length_sec, first_samp=0,
    )

    epochs = mne.Epochs(
        raw, events, tmin=0, tmax=epoch_length_sec,
        baseline=(None, 0),
        reject=dict(eeg=reject_threshold_uv * 1e-6),
        preload=True, verbose=False,
    )

    # Пометим пропущенные (с артефактами)
    return epochs
```

---

## 9. backend/app/services/bandpass_filter.py
**ИЗМЕНЕНО: поддержка одиночной частоты + кастомного диапазона**

```python
"""Частотная фильтрация: δ/θ/α/β/γ + кастомный диапазон + одиночная частота."""
import mne
import numpy as np
from typing import Dict, Optional


def apply_band_filter(
    epochs: mne.Epochs,
    band_name: str = "all",
    custom_min: Optional[float] = None,
    custom_max: Optional[float] = None,
    single_freq: Optional[float] = None,
    bandwidth_hz: float = 0.5,
) -> mne.Epochs:
    """
    Применяет фильтр к эпохам.

    - band_name: 'all', 'delta', 'theta', 'alpha', 'beta', 'gamma'
    - custom_min/custom_max: кастомный диапазон (напр. 7.0–9.5)
    - single_freq: одиночная частота (напр. 7.83 Гц) → narrow bandpass
      bandwidth_hz центрируется на ней (7.58 — 8.08)
    """
    standard_bands = {
        "delta": (1, 4),
        "theta": (4, 8),
        "alpha": (8, 13),
        "beta": (13, 30),
        "gamma": (30, 40),
    }

    if single_freq is not None:
        fmin = single_freq - bandwidth_hz / 2
        fmax = single_freq + bandwidth_hz / 2
        return epochs.copy().filter(
            fmin, fmax, fir_design="firwin", verbose=False
        )

    if band_name == "all":
        return epochs

    if band_name == "custom":
        if custom_min is None or custom_max is None:
            raise ValueError("custom_min и custom_max обязательны для 'custom'")
        fmin, fmax = custom_min, custom_max
    elif band_name in standard_bands:
        fmin, fmax = standard_bands[band_name]
    else:
        raise ValueError(f"Неизвестный диапазон: {band_name}")

    return epochs.copy().filter(
        fmin, fmax, fir_design="firwin", verbose=False
    )


def compute_band_power(epochs: mne.Epochs, bands: Dict[str, tuple]) -> Dict[str, float]:
    """Средняя мощность по каждому диапазону (Welch)."""
    powers = {}
    for name, (fmin, fmax) in bands.items():
        psds, freqs = mne.time_frequency.psd_welch(
            epochs, fmin=fmin, fmax=fmax, n_fft=256, verbose=False
        )
        powers[name] = float(np.mean(psds))
    return powers
```

---

## 10. backend/app/services/dipole_fitter.py

```python
"""fit_dipole + локализация (анатомия + Brodmann)."""
import mne
import numpy as np
from typing import List, Dict
from app.core.config import Settings


def fit_dipoles_for_epochs(epochs: mne.Epochs, settings: Settings, freq_bands: dict):
    cov = _get_covariance(settings)
    bem = _get_bem(settings)
    trans = settings.fsaverage_trans
    subjects_dir = settings.subjects_dir

    all_dips = []
    for i, epoch in enumerate(epochs):
        evoked = epoch.average()
        try:
            dip = mne.fit_dipole(
                evoked, cov, bem, trans=trans,
                min_dist=5.0, n_jobs=1, verbose=False,
            )
            traj = []
            for idx in range(len(dip.pos)):
                traj.append({
                    "time_ms": float(dip.times[idx] * 1000),
                    "pos_head": dip.pos[idx].tolist(),
                    "ori_head": dip.ori[idx].tolist(),
                    "amplitude_nam": float(dip.amplitude[idx] * 1e9),
                    "gof": float(dip.gof[idx]),
                })
            best = max(traj, key=lambda x: x["gof"]) if traj else {}
            all_dips.append({
                "epoch_index": i,
                "n_time_points": len(traj),
                "trajectory": traj,
                "best_fit": best,
            })
        except Exception as e:
            all_dips.append({"epoch_index": i, "error": str(e), "trajectory": [], "best_fit": {}})

    return all_dips


def localize_dipoles(dipoles_result: list, settings: Settings) -> list:
    subjects_dir = settings.subjects_dir
    trans = settings.fsaverage_trans
    ba_labels = mne.read_labels_from_mgovt(
        "fsaverage", parc="aparc.a2009s",
        subjects_dir=subjects_dir,
    )

    for result in dipoles_result:
        if "error" in result or not result.get("trajectory"):
            continue

        traj = result["trajectory"]
        localized = []
        for dp in traj:
            pos = np.array(dp["pos_head"]).reshape(1, 3)

            # MNI
            try:
                mni = mne.head_to_mni(
                    pos, 1, trans, subject="fsaverage",
                    subjects_dir=subjects_dir,
                )
                dp["mni_coords"] = mni[0].tolist()
            except Exception:
                dp["mni_coords"] = [0, 0, 0]

            # Анатомия
            try:
                dp_dip = mne.Dipole(
                    times=[dp["time_ms"] / 1000],
                    pos=pos,
                    amplitude=[dp["amplitude_nam"] * 1e-9],
                    ori=np.array(dp["ori_head"]).reshape(1, 3),
                    gof=[dp["gof"]],
                )
                vol_labels = dp_dip.to_volume_labels(
                    trans, subject="fsaverage",
                    aseg="aparc.a2009s+aseg", subjects_dir=subjects_dir,
                )
                dp["anatomical_structure"] = vol_labels[0] if vol_labels else "unknown"
            except Exception:
                dp["anatomical_structure"] = "unknown"

            # Brodmann
            dp["brodmann_area"] = _find_ba(mni[0], ba_labels, subjects_dir) if "mni" in dir() else "unknown"
            localized.append(dp)

        result["trajectory"] = localized
        if localized:
            result["best_fit"] = max(localized, key=lambda x: x["gof"])

    return dipoles_result


def _find_ba(mni_pos, ba_labels, subjects_dir) -> str:
    """Поиск Brodmann Area по MNI-координатам (через расстояние до меток)."""
    import mne
    try:
        verts = mne.vertex_map(mni_pos, subjects_dir=subjects_dir,
                               subject="fsaverage", trans=None)
        # Ищем метку BA, содержащую эту вершину
        for label in ba_labels:
            if label.name.startswith("BA") and verts in label.vertices:
                return label.name
    except Exception:
        pass
    return "unknown"


def _get_covariance(settings) -> mne.cov.Covariance:
    try:
        return mne.read_cov(f"{settings.subjects_dir}/fsaverage-cov.fif")
    except FileNotFoundError:
        return None


def _get_bem(settings):
    return f"{settings.subjects_dir}/bem/fsaverage-5-embed-mri.bem"
```

---

## 11. backend/app/utils/brain_export.py

```python
"""Экспорт surface-мешей FSAverage в JSON."""
import mne
import os
from app.core.config import settings


def export_fsaverage_surface(settings=None):
    settings = settings or Settings()
    subjects_dir = settings.subjects_dir

    if not os.path.isdir(f"{subjects_dir}/fsaverage"):
        mne.datasets.fsaverage.data_path()

    surfaces = {}
    for hemi in ["lh", "rh"]:
        surf_path = f"{subjects_dir}/fsaverage/surf/{hemi}.inflated"
        verts, faces = mne.surface.io.read_surface(surf_path)

        # Децимация для frontend
        if len(verts) > 10000:
            try:
                import trimesh
                mesh = trimesh.Trimesh(verts, faces)
                mesh = mesh.simplify_quadratic_decimation(8000)
                verts, faces = mesh.vertices, mesh.faces
            except ImportError:
                pass

        surfaces[hemi] = {
            "vertices": verts.tolist(),
            "faces": faces.tolist(),
            "vertex_count": len(verts),
            "face_count": len(faces),
        }

    surfaces["ba_labels"] = _export_ba_labels(settings)
    return surfaces


def _export_ba_labels(settings) -> dict:
    labels = mne.read_labels_from_mgovt(
        "fsaverage", parc="aparc.a2009s",
        subjects_dir=settings.subjects_dir,
    )
    ba_data = {}
    for label in labels:
        if label.name.startswith("BA"):
            ba_data[label.name] = {
                "hemi": label.hemi,
                "vertices": label.vertices.tolist(),
                "n_vertices": len(label.vertices),
            }
    return ba_data
```

---

## 12. backend/app/models/db.py

```python
"""SQLAlchemy модели для PostgreSQL."""
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy import Column, String, Float, Integer, DateTime, JSON, ForeignKey
from datetime import datetime
from app.core.config import settings

engine = create_async_engine(settings.database_url, echo=False)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
Base = declarative_base()


class Session(Base):
    __tablename__ = "sessions"
    id = Column(String, primary_key=True, index=True)
    filename = Column(String)
    n_channels = Column(Integer)
    sfreq = Column(Float)
    duration_sec = Column(Float)
    epoch_length_ms = Column(Float)
    freq_band = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)


class EpochRecord(Base):
    __tablename__ = "epochs"
    id = Column(Integer, primary_key=True)
    session_id = Column(String, ForeignKey("sessions.id"))
    epoch_index = Column(Integer)
    start_time_sec = Column(Float)
    duration_ms = Column(Float)
    has_artifact = Column(Integer, default=0)
    delta_power = Column(Float)
    theta_power = Column(Float)
    alpha_power = Column(Float)
    beta_power = Column(Float)


class Dipole(Base):
    __tablename__ = "dipoles"
    id = Column(Integer, primary_key=True)
    session_id = Column(String, ForeignKey("sessions.id"))
    epoch_id = Column(Integer, ForeignKey("epochs.id"))
    time_ms = Column(Float)
    mni_x = Column(Float)
    mni_y = Column(Float)
    mni_z = Column(Float)
    amplitude_nam = Column(Float)
    gof = Column(Float)
    anatomical_roi = Column(String)
    brodmann_area = Column(String)
    freq_band = Column(String)
    trajectory_json = Column(JSON)  # полная траектория для анимации
```

---

## 13. init_db.sql

```sql
CREATE DATABASE diplock;

-- Таблица сессий
CREATE TABLE IF NOT EXISTS sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    filename        TEXT,
    n_channels      INTEGER,
    sfreq           FLOAT,
    duration_sec    FLOAT,
    epoch_length_ms FLOAT,
    freq_band       TEXT,
    created_at      TIMESTAMP DEFAULT NOW()
);

-- Эпохи
CREATE TABLE IF NOT EXISTS epochs (
    id              SERIAL PRIMARY KEY,
    session_id      TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    epoch_index     INTEGER,
    start_time_sec  FLOAT,
    duration_ms     FLOAT,
    has_artifact    BOOLEAN DEFAULT FALSE,
    delta_power     FLOAT,
    theta_power     FLOAT,
    alpha_power     FLOAT,
    beta_power      FLOAT
);

-- Диполи
CREATE TABLE IF NOT EXISTS dipoles (
    id              SERIAL PRIMARY KEY,
    session_id      TEXT REFERENCES sessions(id),
    epoch_id        INTEGER REFERENCES epochs(id),
    time_ms         FLOAT,
    mni_x           FLOAT,
    mni_y           FLOAT,
    mni_z           FLOAT,
    amplitude_nam   FLOAT,
    gof             FLOAT,
    anatomical_roi  TEXT,
    brodmann_area   TEXT,
    freq_band       TEXT,
    trajectory_json JSONB   -- для анимации
);

-- Групповая статистика
CREATE TABLE IF NOT EXISTS group_analysis (
    id              SERIAL PRIMARY KEY,
    brodmann_area   TEXT,
    anatomical_roi  TEXT,
    freq_band       TEXT,
    n_sessions      INTEGER,
    avg_gof         FLOAT,
    avg_amplitude   FLOAT,
    std_amplitude   FLOAT,
    last_seen       TIMESTAMP DEFAULT NOW()
);

-- Индексы
CREATE INDEX idx_dipoles_ba   ON dipoles(brodmann_area);
CREATE INDEX idx_dipoles_roi  ON dipoles(anatomical_roi);
CREATE INDEX idx_dipoles_freq ON dipoles(freq_band);
CREATE INDEX idx_dipoles_mni  ON dipoles(mni_x, mni_y, mni_z);
```

---

## 14. docker-compose.yml

```yaml
version: "3.9"

services:
  backend:
    build: ./backend
    ports:
      - "8000:8000"
    volumes:
      - ./backend/data:/app/data
      - /tmp/diplock_uploads:/tmp/diplock_uploads
    env_file: .env
    depends_on:
      - db
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

  db:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: diplock
      POSTGRES_USER: neurodipole
      POSTGRES_PASSWORD: neurodipole
    volumes:
      - pg_data:/var/lib/postgresql/data
      - ./init_db.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "5432:5432"

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pg_data:
```

---

## 15. backend/Dockerfile

```dockerfile
FROM python:3.11-slim

WORKDIR /app
RUN apt-get update && apt-get install -y git curl build-essential && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

---

## 16. .env

```env
DATABASE_URL=postgresql+asyncpg://neurodipole:neurodipole@db:5432/diplock
SUBJECTS_DIR=/app/data/fsaverage
FSAVERAGE_TRANS=/app/data/fsaverage/fsaverage-trans.fif
```

---

## 🚀 Быстрый старт в VS Code

```bash
# Создаём структуру
bash setup.sh

# Или вручную создайте папки и файлы из артефакта выше

# Python окружение
cd dip-lock/backend
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt

# Авто-скачивание FSAverage (один раз, ~500 МБ)
python -c "import mne; mne.datasets.fsaverage.data_path(download=True)"

# Старт сервера
uvicorn app.main:app --reload --port 8000
# → Swagger UI: http://localhost:8000/docs
```

> **Cline tip:** Можно сказать Cline: *"Создай структуру проекта DipLock согласно этой схеме, создай все файлы с содержимым из артефакта, установи зависимости и запусти uvicorn"*. Артефакт содержит всю необходимую информацию для автоматизации.

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
