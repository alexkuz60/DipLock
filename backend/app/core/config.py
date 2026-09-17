"""Настройки DipLock через Pydantic Settings."""
from pathlib import Path
from typing import Annotated, Any, Dict, List, Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, NoDecode

# Каталог backend/ и корень репозитория — чтобы дефолтные пути не зависели от CWD.
_BACKEND_DIR = Path(__file__).resolve().parents[2]
_REPO_DIR = _BACKEND_DIR.parent


class Settings(BaseSettings):
    # FastAPI
    app_name: str = "DipLock"
    app_version: str = "0.1.0"
    api_prefix: str = "/api/v1"
    debug: bool = True

    # CORS: origins, которым разрешён доступ к API (без "*" + credentials).
    # 5173 — Vite dev-server, 3000 — CRA, 8000 — сам backend.
    cors_origins: str = Field(
        default=(
            "http://localhost:5173,http://127.0.0.1:5173,"
            "http://localhost:3000,http://127.0.0.1:3000,"
            "http://localhost:8000,http://127.0.0.1:8000"
        ),
        env="CORS_ORIGINS",
    )

    # Фоновые задачи (job API): сколько анализов может идти одновременно
    # и сколько записей хранить в истории задач.
    max_concurrent_jobs: int = Field(default=2, env="MAX_CONCURRENT_JOBS")
    jobs_history_limit: int = Field(default=50, env="JOBS_HISTORY_LIMIT")

    # Загруженные для просмотра записи: лимит истории и TTL (устаревшие
    # каталоги удаляются с диска при обращении к реестру).
    recordings_history_limit: int = Field(default=10, env="RECORDINGS_HISTORY_LIMIT")
    recordings_ttl_hours: int = Field(default=24, env="RECORDINGS_TTL_HOURS")

    # Кэш подготовленного сигнала (A4, этап 2): сколько наборов «запись + полоса +
    # notch + референс» держать в RAM. Один набор — float64-данные записи
    # (130.7 с × 500 Гц × 18 каналов ≈ 9.4 МБ), поэтому по умолчанию 2;
    # 0 — кэш выключен, каждый расчёт читает EDF заново.
    prepared_signal_cache_size: int = Field(default=2, env="PREPARED_SIGNAL_CACHE_SIZE")

    # Пирамида сигналов для вьюера треков (docs/ui.md §8): уровни зума
    # x1…x16 и бюджет точек на канал на уровне x1 (2 × ширина вьюпорта).
    # Уровень k отдаёт не больше `signal_base_points * k` точек на канал,
    # поэтому размер ответа не зависит от длины записи.
    signal_levels: Annotated[List[int], NoDecode] = Field(
        default=[1, 2, 4, 8, 16], env="SIGNAL_LEVELS"
    )
    signal_base_points: int = Field(default=4000, env="SIGNAL_BASE_POINTS")

    @field_validator("signal_levels", mode="before")
    @classmethod
    def _parse_signal_levels(cls, value: Any) -> Any:
        """Принимает и ``1,2,4``, и ``[1,2,4]``: в .env список пишут через запятую.

        Без этого правила pydantic-settings требует JSON и падает при старте на
        «человеческом» значении из `.env.example` (JSON-декодирование идёт
        раньше валидации, поэтому декодирование отключено через ``NoDecode``).
        """
        if isinstance(value, str):
            cleaned = value.strip().strip("[]")
            if not cleaned:
                return []
            return [int(part) for part in cleaned.replace(";", ",").split(",") if part.strip()]
        return value

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
    # Кэш тяжёлых статических ассетов (меш fsaverage, метки Brodmann)
    cache_dir: str = Field(
        default=str(_REPO_DIR / "data" / "cache"),
        env="CACHE_DIR",
    )

    # Журнал шагов (A5, этап 5): JSONL-файл пошаговых замеров под `cache_dir`
    # (`journal.jsonl`). Включён по умолчанию: измерение — один `perf_counter`
    # и одна строка лога на шаг, а без него «почему 8 секунд» выясняется
    # повторным запуском с логами (`docs/data_map.md` §9).
    journal_enabled: bool = Field(default=True, env="JOURNAL_ENABLED")
    # Предел размера файла журнала перед ротацией в `journal.jsonl.1`
    # (старое поколение перезаписывается): журнал не растёт без предела.
    journal_max_bytes: int = Field(default=5_000_000, env="JOURNAL_MAX_BYTES")

    # Единицы EDF: None = автоопределение MNE + эвристика масштаба (см. edf_loader)
    edf_units: Optional[str] = Field(default=None, env="EDF_UNITS")

    # Дипольный фитинг: прореживание evoked по времени для скорости
    # (fit_dipole на каждую временную точку очень дорог). 1 = без прореживания.
    # 5 при 500 Гц даёт 100 Гц → безопасно для сигнала с low-pass до 40 Гц.
    dipole_fit_decim: int = Field(default=5, env="DIPOLE_FIT_DECIM")
    # Максимум эпох для фитинга (0 = все). Ограничивает время ответа API.
    dipole_fit_max_epochs: int = Field(default=0, env="DIPOLE_FIT_MAX_EPOCHS")

    # Артефакты
    z_score_threshold: float = 5.0
    peak_to_peak_threshold_uv: float = 100.0
    flat_line_threshold_uv: float = 5.0
    flat_line_min_duration_ms: float = 200.0
    # Порог reject при нарезке эпох (мкВ): эпохи выше порога отбрасываются MNE.
    # Отдельно от peak_to_peak_threshold_uv: детекция артефактов и reject-фильтр
    # решают разные задачи (первая — аннотации, второй — отбраковка эпох).
    reject_threshold_uv: float = Field(default=150.0, env="REJECT_THRESHOLD_UV")

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
