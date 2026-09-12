"""Настройки DipLock через Pydantic Settings."""
from pydantic import Field
from pydantic_settings import BaseSettings
from typing import Dict, List


class Settings(BaseSettings):
    # FastAPI
    app_name: str = "DipLock"
    debug: bool = True

    # База данных
    database_url: str = Field(
        default="postgresql+asyncpg://neurodipole:neurodipole@db:5432/diplock",
        env="DATABASE_URL",
    )

        # FSAverage
    subjects_dir: str = Field(
        default="/home/alexkuz60/mne_data/MNE-fsaverage-data",
        env="SUBJECTS_DIR",
    )
    fsaverage_trans: str = Field(
        default="/home/alexkuz60/mne_data/MNE-fsaverage-data/fsaverage/bem/fsaverage-trans.fif",
        env="FSAVERAGE_TRANS",
    )

    # Папки для загрузки и результатов (локальная разработка)
    upload_dir: str = Field(
        default="/app/data/edf",
        env="UPLOAD_DIR",
    )
    results_dir: str = Field(
        default="/app/data/results",
        env="RESULTS_DIR",
    )

    # Артефакты
    z_score_threshold: float = 5.0
    peak_to_peak_threshold_uv: float = 100.0
    flat_line_threshold_uv: float = 5.0
    flat_line_min_duration_ms: float = 200.0

    # Нарезка эпох (без overlap)
    epoch_lengths_ms: List[float] = [250, 500, 750, 1000, 1250, 1500, 1750, 2000]
    default_epoch_length_ms: float = 2000.0

    # Частотные диапазазы
    freq_bands: Dict[str, tuple] = {
        "delta": (1, 4),
        "theta": (4, 8),
        "alpha": (8, 13),
        "beta": (13, 30),
        "gamma": (30, 40),
    }
    default_single_freq_bandwidth_hz: float = 0.5  # для одиночной частоты

    # 10-20 каналы
    standard_channels: List[str] = [
        "Fp1", "Fp2", "F3", "F4", "C3", "C4",
        "P3", "P4", "O1", "O2", "F7", "F8",
        "T7", "T8", "P7", "P8", "Fz", "Cz",
        "Pz", "Oz",
    ]

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
