"""
Заявленные зависимости (F3): runtime-импорты приложения обязаны быть в requirements.

CI ставит зависимости из `requirements-dev.txt` в чистое окружение — то, что «случайно»
лежит в локальном venv транзитивной зависимостью, в CI не появляется. Прецеденты:
`aiosqlite` (F3) и `greenlet` для `sqlalchemy.ext.asyncio` (случай 26.09.2026) — оба
падали только в CI и только на сборе тестов БД.
"""
from pathlib import Path

_BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _requirements() -> str:
    """Текст обоих файлов зависимостей (dev включает runtime через `-r`)."""
    return "\n".join(
        (_BACKEND_ROOT / name).read_text(encoding="utf-8")
        for name in ("requirements.txt", "requirements-dev.txt")
    )


def test_sqlalchemy_asyncio_extra_declared() -> None:
    """`app/models/db.py` создаёт asyncio-движок на импорте: нужен extra с greenlet."""
    assert "sqlalchemy[asyncio]" in _requirements()


def test_aiosqlite_declared() -> None:
    """Локальный `DATABASE_URL=sqlite+aiosqlite://…` — драйвер заявлен явно (F3)."""
    assert "aiosqlite" in _requirements()
