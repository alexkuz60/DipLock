"""Версии окружения: для /meta, /init-status и provenance результата (F16)."""
import sys
from typing import Dict, Optional


def library_versions() -> Dict[str, Optional[str]]:
    """Версии Python и научных библиотек (``trimesh`` опционален → None)."""
    import mne
    import numpy
    import scipy
    import sqlalchemy

    versions: Dict[str, Optional[str]] = {
        "python": sys.version.split()[0],
        "mne": mne.__version__,
        "numpy": numpy.__version__,
        "scipy": scipy.__version__,
        "sqlalchemy": sqlalchemy.__version__,
        "trimesh": None,
    }
    try:
        import trimesh

        versions["trimesh"] = trimesh.__version__
    except Exception:  # trimesh опционален (децимация мешей)
        pass
    return versions
