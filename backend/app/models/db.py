"""SQLAlchemy модели для локального режима (SQLite).

Схему создаёт и изменяет **только alembic** (`init_db` поднимает её до head,
`alembic/versions/` — замороженные определения, 4.2); `Base.metadata` здесь —
источник истины для autogenerate, расхождение с миграциями ловит страж
`tests/test_migrations.py::test_migration_schema_matches_models`.
"""
import asyncio
from datetime import datetime
from pathlib import Path

from alembic.config import Config
from sqlalchemy import JSON, Column, DateTime, Float, ForeignKey, Index, Integer, String
from sqlalchemy.dialects import postgresql
from sqlalchemy.engine import URL
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from alembic import command
from app.core.config import settings

# SQLite для локальной разработки; PostgreSQL используется в продакшене через docker-compose
# URL берём из settings (загружает .env) для единой конфигурации.
DATABASE_URL = settings.database_url

engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

# alembic.ini и каталог миграций лежат в backend/ (db.py → app/models/ → backend/).
_BACKEND_DIR = Path(__file__).resolve().parents[2]
_ALEMBIC_INI = _BACKEND_DIR / "alembic.ini"



class Base(DeclarativeBase):
    """Базовый класс моделей: ``DeclarativeBase`` (SQLAlchemy 2.0) вместо ``declarative_base()``."""


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
    """Эпоха сессии: все полосы сетки ``freq_bands`` (4.1, N38).

    Колонки мощностей — ровно ключи ``settings.freq_bands`` + ``_power``:
    раньше таблица хранила 4 полосы при 7 в конфиге, и γ и новые полосы
    молча терялись при записи. Смена сетки — только вместе с колонками и
    **новой миграцией** alembic (догонка старых файлов — в ревизии ``0001``,
    страж паритета — `tests/test_migrations.py`).
    """

    __tablename__ = "epochs"
    id = Column(Integer, primary_key=True)
    session_id = Column(String, ForeignKey("sessions.id"), index=True)
    epoch_index = Column(Integer)
    start_time_sec = Column(Float)
    duration_ms = Column(Float)
    has_artifact = Column(Integer, default=0)
    delta_power = Column(Float)
    delta_theta_power = Column(Float)
    theta_power = Column(Float)
    alpha_power = Column(Float)
    beta_power = Column(Float)
    gamma_power = Column(Float)
    high_gamma_power = Column(Float)


class Dipole(Base):
    __tablename__ = "dipoles"
    # Индексы под запросы Фазы 5 (N37): фильтры таблицы и агрегация по ROI/полосе.
    __table_args__ = (
        Index("ix_dipoles_trajectory_json", "trajectory_json", postgresql_using="gin"),
    )
    id = Column(Integer, primary_key=True)
    session_id = Column(String, ForeignKey("sessions.id"), index=True)
    epoch_id = Column(Integer, ForeignKey("epochs.id"), index=True)
    time_ms = Column(Float)
    mni_x = Column(Float)
    mni_y = Column(Float)
    mni_z = Column(Float)
    amplitude_nam = Column(Float)
    gof = Column(Float, index=True)
    anatomical_roi = Column(String)
    brodmann_area = Column(String, index=True)
    freq_band = Column(String)
    # JSON, а в PostgreSQL — jsonb + GIN (N37): на SQLite вариант игнорируется.
    trajectory_json = Column(JSON().with_variant(postgresql.JSONB(), "postgresql"))


def _sync_driver_url(url: URL) -> str:
    """Синхронный URL для alembic: срезаем async-драйвер из URL движка.

    ``sqlite+aiosqlite`` → ``sqlite``, ``postgresql+asyncpg`` → ``postgresql``
    (поставляемый psycopg2-binary): миграции выполняются синхронным API.
    ``str(url)`` маскирует пароль («***») — берём ``render_as_string`` явно,
    иначе подключение к PostgreSQL ушло бы с паролем-заглушкой.
    """
    sync = url.set(drivername=url.drivername.partition("+")[0])
    return sync.render_as_string(hide_password=False)


def _upgrade_to_head(database_url: str) -> None:
    """Поднимает схему до последней ревизии alembic (блокирующий I/O — для потока).

    URL передаётся явно: тесты подменяют ``engine`` на изолированную БД,
    а ``alembic.ini`` URL не задаёт (env.py иначе взял бы ``settings``).
    """
    config = Config(str(_ALEMBIC_INI))
    # set_main_option использует ConfigParser-интерполяцию: % в URL экранируем.
    config.set_main_option("sqlalchemy.url", database_url.replace("%", "%%"))
    command.upgrade(config, "head")


async def init_db() -> None:
    """Поднимает схему БД до head: схему создают и меняют только миграции.

    Файлы, созданные ``create_all`` до alembic (в т.ч. «до 4.1» с 4 полосами),
    ревизия ``0001`` догоняет автоматически — ручная догонка (4.1) удалена.
    Выполняется в отдельном потоке: синхронные запросы блокируют event loop.
    """
    await asyncio.to_thread(_upgrade_to_head, _sync_driver_url(engine.url))

