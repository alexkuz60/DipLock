"""SQLAlchemy модели для локального режима (SQLite)."""
import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, declarative_base
from sqlalchemy import Column, String, Float, Integer, DateTime, JSON, ForeignKey
from datetime import datetime

# SQLite для локальной разработки; PostgreSQL используется в продакшене через docker-compose
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "sqlite+aiosqlite:///./diplock.db",
)

engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
Base = declarative_base()


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
    __tablename__ = "epochs"
    id = Column(Integer, primary_key=True)
    session_id = Column(String, ForeignKey("sessions.id"))
    epoch_index = Column(Integer)
    start_time_sec = Column(Float)
    duration_ms = Column(Float)
    has_artifact = Column(Integer, default=0)
    delta_power = Column(Float)
    theta_power = Column(Float)
    alpha_power = Column(Float)
    beta_power = Column(Float)


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


# Асинхронная функция для создания таблиц
async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
