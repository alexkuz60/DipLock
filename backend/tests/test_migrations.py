"""Миграции alembic: подъём схемы, паритет с моделями и догонка старых файлов (4.2).

Схему создаёт только ``0001_baseline`` (``create_all`` в ``init_db`` удалён),
поэтому здесь три страховки:

1. свежий файл получает все таблицы и ``alembic_version`` на head;
2. **страж паритета**: миграционная схема == ``Base.metadata`` (колонки, типы,
   индексы) — правка модели без миграции падает тестом, а не молча расходится;
3. повторный запуск идемпотентен (``init_db`` вызывается на каждом сохранении).

Догонка файла «до 4.1» (4 полосы вместо 7) — в ``test_analysis_db.py``:
``test_init_db_upgrades_legacy_db_with_four_band_columns``.
"""
import asyncio
import sqlite3

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import create_engine, inspect
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.models import db as db_module


def _alembic_head() -> str | None:
    """Текущий head дерева миграций (без подключения к БД)."""
    return ScriptDirectory.from_config(Config(str(db_module._ALEMBIC_INI))).get_current_head()


def _rows(path, sql: str) -> list:
    """Строки изолированной SQLite (своё соединение: тест и сервис не делят его)."""
    con = sqlite3.connect(path)
    try:
        return con.execute(sql).fetchall()
    finally:
        con.close()


def _migrate(tmp_path, monkeypatch, *, name: str = "migrated.db"):
    """Подменяет движок на изолированный и поднимает схему до head через init_db."""
    path = tmp_path / name
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}")
    maker = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db_module, "engine", engine)
    monkeypatch.setattr(db_module, "AsyncSessionLocal", maker)
    asyncio.run(db_module.init_db())
    return path


def test_init_db_creates_schema_and_version(tmp_path, monkeypatch):
    """Свежий файл: все таблицы схемы (вкл. 4.4) + alembic_version на head."""
    path = _migrate(tmp_path, monkeypatch)

    tables = {row[0] for row in _rows(path, "select name from sqlite_master where type='table'")}
    assert {
        "sessions", "epochs", "dipoles",
        # 4.4: шаг ① записи, шаг ③ кирпичный слой (шаг ② добавляет колонки)
        "recordings", "analyses", "analysis_bands", "dipole_points",
        "report_runs", "report_band_summaries", "report_name_counts", "report_dynamics",
        "alembic_version",
    } <= tables
    assert _rows(path, "select version_num from alembic_version") == [(_alembic_head(),)]


def test_migration_schema_matches_models(tmp_path, monkeypatch):
    """Страж: колонки, типы и индексы миграции == ``Base.metadata`` (4.2, N37).

    Миграции заморожены (не импортируют модели) — именно поэтому модель,
    изменённая без новой ревизии, падает здесь, а не в проде.
    """
    path = _migrate(tmp_path, monkeypatch)
    engine = create_engine(f"sqlite:///{path}")
    try:
        inspector = inspect(engine)
        for name, table in db_module.Base.metadata.tables.items():
            assert inspector.has_table(name), f"миграция не создала таблицу {name}"
            real = {c["name"]: c["type"] for c in inspector.get_columns(name)}
            for column in table.c:
                assert column.name in real, f"{name}.{column.name} нет в миграции"
                migrated = real[column.name].compile(dialect=engine.dialect)
                modeled = column.type.compile(dialect=engine.dialect)
                assert migrated == modeled, f"{name}.{column.name}: {migrated} != {modeled}"

            model_indexes = {(i.name, tuple(c.name for c in i.columns)) for i in table.indexes}
            real_indexes = {
                (idx["name"], tuple(idx["column_names"])) for idx in inspector.get_indexes(name)
            }
            assert real_indexes == model_indexes, f"{name}: индексы разошлись"
    finally:
        engine.dispose()


def test_init_db_is_idempotent(tmp_path, monkeypatch):
    """Повторный init_db (вызывается на каждом сохранении) — no-op без ошибок."""
    path = _migrate(tmp_path, monkeypatch)
    asyncio.run(db_module.init_db())
    assert _rows(path, "select version_num from alembic_version") == [(_alembic_head(),)]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("sqlite+aiosqlite:///./diplock.db", "sqlite:///./diplock.db"),
        ("sqlite+aiosqlite:////tmp/x.db", "sqlite:////tmp/x.db"),
        # Пароль должен дойти до подключения целиком (str(URL) маскирует его).
        ("postgresql+asyncpg://user:pw@db:5432/diplock", "postgresql://user:pw@db:5432/diplock"),
    ],
)
def test_sync_driver_url_strips_async_driver(raw, expected):
    """URL для alembic теряет async-драйвер, остальное (включая пароль) не меняется."""
    from sqlalchemy.engine import make_url

    assert db_module._sync_driver_url(make_url(raw)) == expected
