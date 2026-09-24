"""Версии окружения: для /meta, /init-status и provenance результата (F16)."""
import sys
from contextlib import suppress
from datetime import datetime
from pathlib import Path


def library_versions() -> dict[str, str | None]:
    """Версии Python и научных библиотек (``trimesh`` опционален → None)."""
    import mne
    import numpy
    import scipy
    import sqlalchemy

    versions: dict[str, str | None] = {
        "python": sys.version.split()[0],
        "mne": mne.__version__,
        "numpy": numpy.__version__,
        "scipy": scipy.__version__,
        "sqlalchemy": sqlalchemy.__version__,
        "trimesh": None,
    }
    with suppress(Exception):  # trimesh опционален (децимация мешей)
        import trimesh

        versions["trimesh"] = trimesh.__version__
    return versions


_PROCESS_STARTED_AT = datetime.now()


def code_freshness(
    app_dir: Path | None = None,
    started_at: datetime | None = None,
) -> dict[str, str | bool]:
    """Свежесть кода относительно запущенного процесса (обновление бэкенда).

    ``stale=True`` — исходники ``app/`` **новее** старта процесса: uvicorn работает
    на старом коде (запустили до правок и без ``--reload``). Симптомы в UI:
    счётчики артефактов разъезжаются (тултип задачи против пиуль легенды),
    нарезка эпох падает по старым зонам (случай 24.09.2026). Лечение — перезапуск
    сервера и «Пересчитать» запись: файлы задач и результаты стадий переживают
    перезагрузку и продолжают отдавать старые числа.
    """
    root = app_dir if app_dir is not None else Path(__file__).resolve().parents[1]
    start = started_at if started_at is not None else _PROCESS_STARTED_AT
    start_ts = start.timestamp()
    latest_ts = max(
        (path.stat().st_mtime for path in root.rglob("*.py") if path.is_file()),
        default=start_ts,
    )
    return {
        "code_mtime": datetime.fromtimestamp(latest_ts).isoformat(timespec="seconds"),
        "server_started_at": start.isoformat(timespec="seconds"),
        "stale": latest_ts > start_ts,
    }
