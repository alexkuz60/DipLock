"""SQLAlchemy модели для локального режима (SQLite)."""
from datetime import datetime

from sqlalchemy import JSON, Column, DateTime, Float, ForeignKey, Integer, String, inspect, text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

# SQLite для локальной разработки; PostgreSQL используется в продакшене через docker-compose
# URL берём из settings (загружает .env) для единой конфигурации.
DATABASE_URL = settings.database_url

engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


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
    молча терялись при записи. Смена сетки — только вместе с колонками:
    до alembic (4.2) ручной догонкой в ``init_db``, после — миграцией.
    """

    __tablename__ = "epochs"
    id = Column(Integer, primary_key=True)
    session_id = Column(String, ForeignKey("sessions.id"))
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
    id = Column(Integer, primary_key=True)
    session_id = Column(String, ForeignKey("sessions.id"))
    epoch_id = Column(Integer, ForeignKey("epochs.id"))
    time_ms = Column(Float)
    mni_x = Column(Float)
    mni_y = Column(Float)
    mni_z = Column(Float)
    amplitude_nam = Column(Float)
    gof = Column(Float)
    anatomical_roi = Column(String)
    brodmann_area = Column(String)
    freq_band = Column(String)
    trajectory_json = Column(JSON)  # полная траектория для анимации


def _add_missing_columns(conn: Connection) -> None:
    """Догоняет колонки существующих таблиц до модели (ручная правка до alembic).

    ``create_all`` создаёт отсутствующие таблицы, но **не меняет** существующие:
    файл БД, созданный до 4.1 (4 полосы вместо 7), иначе падал бы на вставке
    эпох («no such column»). Идентификаторы берутся из ``Base.metadata`` —
    это собственная схема, а не пользовательский ввод. После введения
    alembic-миграций (todo 4.2) шаг заменит миграция.
    """
    inspector = inspect(conn)
    for table in Base.metadata.sorted_tables:
        existing = {column["name"] for column in inspector.get_columns(table.name)}
        for column in table.c:
            if column.name in existing:
                continue
            type_sql = column.type.compile(dialect=conn.dialect)
            conn.execute(
                text(f"ALTER TABLE {table.name} ADD COLUMN {column.name} {type_sql}")
            )


async def init_db():
    """Создаёт таблицы и догоняет колонки старых файлов БД (см. ``_add_missing_columns``)."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_add_missing_columns)
