"""DipLock FastAPI entry-point."""
import os
from typing import Dict
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from app.core.config import settings

from app.api.routes import router as api_router

app = FastAPI(
    title="DipLock",
    description="Анализ ЭЭГ и расчёт токовых диполей в 3D",
    version="0.1.0",
)

# CORS: конкретные origins (без "*" + credentials). Разрешаем локальную разработку.
_default_cors = "http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000,http://127.0.0.1:8000"
cors_origins = [o.strip() for o in os.getenv("CORS_ORIGINS", _default_cors).split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Монтируем статические файлы (index.html)
static_dir = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(static_dir):
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

app.include_router(api_router, prefix="/api/v1")


@app.get("/", response_class=HTMLResponse)
async def root():
    """Отдаёт стартовую страницу DipLock."""
    index_path = os.path.join(static_dir, "index.html")
    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())
    return HTMLResponse(
        "<h1>DipLock</h1><p>Добро пожаловать! "
        "<a href='/api/v1/docs'>Документация API</a></p>"
    )


@app.get("/init-status")
async def init_status() -> Dict:
    """Проверка готовности всех компонентов для стартовой страницы."""
    import mne

    checks: Dict[str, str] = {}

    # 1. MNE-Python
    try:
        _ = mne.__version__
        checks["mne"] = "ready"
    except Exception:
        checks["mne"] = "error"

    # 2. Конфигурация
    try:
        _ = settings.app_name
        _ = settings.subjects_dir
        checks["config"] = "ready"
    except Exception:
        checks["config"] = "error"

    # 3. База данных
    try:
        from sqlalchemy.engine import make_url
        db_url = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./diplock.db")
        url = make_url(db_url)
        if url.drivername.startswith("sqlite"):
            db_path = url.database or "./diplock.db"
            if not os.path.isabs(str(db_path)):
                db_path = os.path.join(
                    os.path.dirname(os.path.dirname(__file__)),
                    str(db_path),
                )
            os.makedirs(os.path.dirname(str(db_path)) or ".", exist_ok=True)
            checks["database"] = "ready"
        else:
            from app.models.db import engine
            from sqlalchemy import text
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
            checks["database"] = "ready"
    except Exception:
        checks["database"] = "error"

        # 4. FSAverage данные
    try:
        subjects_dir = settings.subjects_dir
        fsaverage_dir = os.path.join(subjects_dir, "fsaverage")
        mne_data = os.path.expanduser("~/mne_data/MNE-fsaverage-data")
        # Локальный fallback: ищем в ~/mne_data/fsaverage
        local_fsaverage = os.path.join(mne_data, "fsaverage")
        if os.path.isdir(fsaverage_dir) or os.path.isdir(mne_data) or os.path.isdir(local_fsaverage):
            checks["fsaverage"] = "ready"
        else:
            # Пытаемся получить путь (без принудительной загрузки)
            mne.datasets.fsaverage.data_path()
            checks["fsaverage"] = "ready"
    except Exception:
        checks["fsaverage"] = "loading"

    # 5. FSAverage transform
    try:
        subjects_dir = settings.subjects_dir
        trans_path = settings.fsaverage_trans
        # Локальный fallback для transform
        local_trans = os.path.expanduser("~/mne_data/MNE-fsaverage-data/fsaverage/bem/fsaverage-trans.fif")
        local_trans2 = os.path.join(subjects_dir, "bem", "fsaverage-trans.fif")
        if os.path.exists(trans_path) or os.path.exists(local_trans) or os.path.exists(local_trans2):
            checks["transform"] = "ready"
        else:
            checks["transform"] = "error"
    except Exception:
        checks["transform"] = "error"

    # 6. BEM (модель головы)
    try:
        subjects_dir = settings.subjects_dir
        bem_paths = [
            os.path.join(subjects_dir, "bem"),
            os.path.join(subjects_dir, "fsaverage", "bem"),
            os.path.expanduser("~/mne_data/MNE-fsaverage-data/fsaverage/bem"),
        ]
        if any(os.path.isdir(p) for p in bem_paths):
            checks["bem"] = "ready"
        else:
            checks["bem"] = "error"
    except Exception:
        checks["bem"] = "error"

    ready = all(v == "ready" for v in checks.values())
    return {"checks": checks, "status": "ready" if ready else "pending"}


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "dip-lock-backend"}
