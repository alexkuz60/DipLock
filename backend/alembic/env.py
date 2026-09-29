"""Окружение alembic: синхронный URL и метаданные моделей (4.2).

URL берётся в таком порядке:

1. ``sqlalchemy.url`` из программного вызова — ``app.models.db.init_db``
   подставляет URL своего движка (тесты работают на изолированной tmp-БД);
2. иначе ``settings.database_url`` — режим CLI ``venv/bin/alembic …``.

Асинхронный драйвер срезается (``sqlite+aiosqlite`` → ``sqlite``,
``postgresql+asyncpg`` → ``postgresql``): миграции alembic работают через
синхронный SQLAlchemy-API, а пул соединений тут одноразовый.
"""

from sqlalchemy import create_engine, make_url

from alembic import context
from app.core.config import settings
from app.models.db import Base

config = context.config

# Метаданные для autogenerate: сравнивает модели с БД на head.
target_metadata = Base.metadata


def _sync_url(url: str) -> str:
    """Убирает async-драйвер из URL: ``sqlite+aiosqlite`` → ``sqlite`` и т.п.

    Alembic выполняет миграции синхронным API; по умолчанию ``postgresql`` —
    psycopg2 (заявлен в requirements.txt) и pysqlite для SQLite.
    """
    parsed = make_url(url)
    return str(parsed.set(drivername=parsed.drivername.partition("+")[0]))


def _database_url() -> str:
    """URL для миграций: программный override → settings (см. докстринг модуля)."""
    configured = config.get_main_option("sqlalchemy.url")
    if configured:
        return configured
    # set_main_option использует ConfigParser-интерполяцию: «сырой» % ломает чтение.
    sync = _sync_url(settings.database_url)
    config.set_main_option("sqlalchemy.url", sync.replace("%", "%%"))
    return sync


def run_migrations_offline() -> None:
    """Офлайн-режим: SQL печатается в stdout без подключения к БД."""
    context.configure(
        url=_database_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        # SQLite не умеет большинство ALTER — batch-режим и для будущих автогенераций.
        render_as_batch=True,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Онлайн-режим: обычное выполнение миграций против БД."""
    engine = create_engine(_database_url())
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            render_as_batch=True,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
