"""Гейт документации API (``ENABLE_DOCS``): облако не отдаёт /docs и /openapi.json."""
from app.core.config import Settings
from app.main import _docs_kwargs


def test_docs_enabled_by_default() -> None:
    """Локально схема API доступна: /docs и /openapi.json включены."""
    cfg = Settings(_env_file=None, enable_docs=True)
    assert _docs_kwargs(cfg) == {
        "docs_url": "/docs",
        "redoc_url": None,
        "openapi_url": "/openapi.json",
    }


def test_docs_disabled_in_cloud() -> None:
    """В облаке ENABLE_DOCS=false убирает и страницу, и схему API."""
    cfg = Settings(_env_file=None, enable_docs=False)
    assert _docs_kwargs(cfg) == {
        "docs_url": None,
        "redoc_url": None,
        "openapi_url": None,
    }
