"""DipLock FastAPI entry-point."""
import logging
import os
from contextlib import asynccontextmanager
from typing import AsyncIterator, Dict

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import router as api_router
from app.core.config import settings
from app.services.job_manager import job_manager
from app.services.orphans import sweep_orphans
from app.utils.versions import library_versions

logger = logging.getLogger(__name__)

# Статика: legacy-страница (index.html) и собранный frontend (ui/)
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
UI_DIR = os.path.join(STATIC_DIR, "ui")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Старт приложения: уборка сирот и подъём истории задач (этап 6).

    Реестр записей — in-memory, поэтому всё, что осталось от прошлых запусков
    процесса, никто не уберёт: каталоги без сайдкара, кэши и файлы задач
    исчезнувших записей (A6) живут вечно. Здесь они сносятся один раз при старте
    (``services/orphans.py``), а завершённые задачи поднимаются с диска, чтобы
    история и ссылки на результат не терялись (A8). Обе операции best-effort:
    сбой уборки не мешает сервису подняться.
    """
    report = sweep_orphans(settings)
    if report.total:
        logger.info("Уборка сирот при старте: %s", report.as_dict())
    restored = job_manager.restore(settings)
    if restored:
        logger.info("Поднято задач из файлов на диске: %d", restored)
    yield


app = FastAPI(
    title=settings.app_name,
    description="Анализ ЭЭГ и расчёт токовых диполей в 3D",
    version=settings.app_version,
    lifespan=lifespan,
)


# CORS: конкретные origins из settings (без "*" + credentials). Vite dev-server
# ходит через proxy (CORS не нужен), но 5173 разрешён и напрямую (F14).
cors_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Тяжёлые JSON-ассеты (меш fsaverage, индексы Brodmann) сжимаем на лету
app.add_middleware(GZipMiddleware, minimum_size=1024)

# Legacy-статика (стартовая страница-заглушка)
if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

app.include_router(api_router, prefix=settings.api_prefix)


def _read_html(path: str) -> str:
    """Читает HTML-файл (utf-8)."""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()



@app.get("/", include_in_schema=False)
async def root():
    """Корень: собранный UI (если есть), иначе legacy-страница."""
    if os.path.exists(os.path.join(UI_DIR, "index.html")):
        return RedirectResponse(url="/ui/")
    return await legacy_page()


@app.get("/ui/{rest_of_path:path}", include_in_schema=False)
async def ui_app(rest_of_path: str = ""):
    """Раздаёт собранный frontend: файлы — как есть, остальные пути — index.html.

    SPA-fallback нужен, чтобы глубокие ссылки (``/ui/edf``) работали после
    перезагрузки страницы; проверка ``startswith(UI_DIR)`` защищает от ``../``.
    """
    index_path = os.path.join(UI_DIR, "index.html")
    if not os.path.exists(index_path):
        raise HTTPException(
            status_code=404,
            detail="UI не собран. Выполните: cd frontend && npm install && npm run build",
        )
    if rest_of_path:
        candidate = os.path.normpath(os.path.join(UI_DIR, rest_of_path))
        if candidate.startswith(UI_DIR + os.sep) and os.path.isfile(candidate):
            return FileResponse(candidate)
    return HTMLResponse(_read_html(index_path))


@app.get("/legacy", response_class=HTMLResponse, include_in_schema=False)
async def legacy_page():
    """Старая стартовая страница (поллинг /init-status) — до сборки UI."""
    index_path = os.path.join(STATIC_DIR, "index.html")
    if os.path.exists(index_path):
        return HTMLResponse(_read_html(index_path))
    return HTMLResponse(
        "<h1>DipLock</h1><p>Добро пожаловать! "
        "<a href='/docs'>Документация API</a></p>"
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
        db_url = settings.database_url
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
    return {
        "checks": checks,
        "status": "ready" if ready else "pending",
        # Расширенная информация для раздела UI «Состояние сервера»
        "versions": library_versions(),
        "ui": {
            "built": os.path.exists(os.path.join(UI_DIR, "index.html")),
            "url": "/ui/",
            "legacy_url": "/legacy",
        },
        "paths": {
            "subjects_dir": settings.subjects_dir,
            "fsaverage_trans": settings.fsaverage_trans,
            "upload_dir": settings.upload_dir,
            "results_dir": settings.results_dir,
            "cache_dir": settings.cache_dir,
        },
        "api": {
            "prefix": settings.api_prefix,
            "docs_url": "/docs",
            "meta_url": f"{settings.api_prefix}/meta",
        },
    }


@app.get("/health")
async def health_check():
    return {"status": "ok", "service": "dip-lock-backend"}
