"""Версии окружения: для /meta, /init-status и provenance результата (F16)."""
import sys
from contextlib import suppress


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
