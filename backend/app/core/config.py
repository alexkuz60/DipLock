"""Настройки DipLock через Pydantic Settings."""
from pathlib import Path
from typing import Annotated, Any

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

    # Логирование (N29): без конфигурации root-logger не имеет handlers, а
    # эффективный уровень `app.*` — WARNING, поэтому все logger.info сервисов
    # молчали. Уровень настраивается (LOG_LEVEL=DEBUG и т.п.), применяется
    # в app/main.py при старте.
    log_level: str = Field(default="INFO")


    # CORS: origins, которым разрешён доступ к API (без "*" + credentials).
    # 5173 — Vite dev-server, 3000 — CRA, 8000 — сам backend.
    cors_origins: str = Field(
        default=(
            "http://localhost:5173,http://127.0.0.1:5173,"
            "http://localhost:3000,http://127.0.0.1:3000,"
            "http://localhost:8000,http://127.0.0.1:8000"
        ),
    )

    # Фоновые задачи (job API): сколько анализов может идти одновременно
    # и сколько записей хранить в истории задач.
    max_concurrent_jobs: int = Field(default=2)
    jobs_history_limit: int = Field(default=50)

    # Загруженные для просмотра записи: лимит истории и TTL (устаревшие
    # каталоги удаляются с диска при обращении к реестру).
    recordings_history_limit: int = Field(default=10)
    recordings_ttl_hours: int = Field(default=24)

    # Кэш подготовленного сигнала (A4, этап 2): сколько наборов «запись + полоса +
    # notch + референс» держать в RAM. Один набор — float64-данные записи
    # (130.7 с × 500 Гц × 18 каналов ≈ 9.4 МБ), поэтому по умолчанию 2;
    # 0 — кэш выключен, каждый расчёт читает EDF заново.
    prepared_signal_cache_size: int = Field(default=2)

    # Пирамида сигналов для вьюера треков (docs/ui.md §8): уровни зума
    # x1…x16 и бюджет точек на канал на уровне x1 (2 × ширина вьюпорта).
    # Уровень k отдаёт не больше `signal_base_points * k` точек на канал,
    # поэтому размер ответа не зависит от длины записи.
    signal_levels: Annotated[list[int], NoDecode] = Field(
        default=[1, 2, 4, 8, 16]
    )
    signal_base_points: int = Field(default=4000)

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
    )

        # FSAverage
    subjects_dir: str = Field(
        default="/home/alexkuz60/mne_data/MNE-fsaverage-data",
    )
    fsaverage_trans: str = Field(
        default="/home/alexkuz60/mne_data/MNE-fsaverage-data/fsaverage/bem/fsaverage-trans.fif",
    )

    # Папки для загрузки и результатов (локальная разработка)
    upload_dir: str = Field(
        default="/app/data/edf",
    )
    results_dir: str = Field(
        default="/app/data/results",
    )
    # Кэш тяжёлых статических ассетов (меш fsaverage, метки Brodmann)
    cache_dir: str = Field(
        default=str(_REPO_DIR / "data" / "cache"),
    )

    # Журнал шагов (A5, этап 5): JSONL-файл пошаговых замеров под `cache_dir`
    # (`journal.jsonl`). Включён по умолчанию: измерение — один `perf_counter`
    # и одна строка лога на шаг, а без него «почему 8 секунд» выясняется
    # повторным запуском с логами (`docs/data_map.md` §9).
    journal_enabled: bool = Field(default=True)
    # Предел размера файла журнала перед ротацией в `journal.jsonl.1`
    # (старое поколение перезаписывается): журнал не растёт без предела.
    journal_max_bytes: int = Field(default=5_000_000)

    # Результаты задач (A8, этап 6): завершённая задача пишется на диск
    # (`results_dir/jobs/<job_id>.json`), поэтому история и результат переживают
    # рестарт процесса. Тяжёлые бинарные артефакты (сетки, PNG) остаются в
    # дисковых кэшах — в файл задачи идёт только сводка; результат больше
    # `JOB_RESULT_MAX_BYTES` не сохраняется (история важнее результата).
    job_store_enabled: bool = Field(default=True)
    job_result_max_bytes: int = Field(default=2_000_000)


    # Единицы EDF: None = автоопределение MNE + эвристика масштаба (см. edf_loader)
    edf_units: str | None = Field(default=None)

    # Дипольный фитинг: прореживание evoked по времени для скорости
    # (fit_dipole на каждую временную точку очень дорог). 1 = без прореживания.
    # 5 при 500 Гц даёт 100 Гц → безопасно для сигнала с low-pass до 40 Гц.
    dipole_fit_decim: int = Field(default=5)
    # Максимум эпох для фитинга (0 = все). Ограничивает время ответа API.
    dipole_fit_max_epochs: int = Field(default=0)
    # Потоков внутри одной эпохи (`mne.fit_dipole(n_jobs=...)`). 1 = один поток:
    # mne.fit_dipole сам параллелит точки внутри evoked.
    dipole_fit_n_jobs: int = Field(default=1)
    # Оценка времени одной точки траектории (с) — подсказка «сколько ждать» до
    # запуска, а не параметр расчёта. Замер — `audit.md` §7.7 (F19).
    dipole_fit_sec_per_point: float = Field(default=5.4)

    # Точное уточнение одной эпохи (F19, кнопка «Уточнить…»): половина окна
    # вокруг пика GFP (мс), в котором идёт последовательный fit_dipole. **0 —
    # фитится только пик** (один отсчёт): это и есть точка, которую показывает
    # быстрый расчёт. Замер 20.09.2026 на BEM fsaverage (18 каналов 10-20):
    # постоянная цена вызова (сетка guesses 20 мм + форварды) ≈ 8 с, каждый
    # следующий отсчёт окна ≈ 7 с (11 отсчётов ≈ 80 с, в записи задачи — 97–109 с
    # при прежнем дефолте 10 мс). Широкое окно — осознанный выбор пользователя,
    # а не «на всякий случай»: правило — `docs/rules/dipoles.md`.
    dipole_refine_halfwin_ms: float = Field(default=0.0)
    # Предел окна из формы (мс): защита от «случайных 200 мс» (это десятки минут).
    dipole_refine_halfwin_max_ms: float = Field(default=20.0)
    # Потоки fit_dipole при уточнении: -1 = все ядра. Параллелизм работает
    # только при установленном `joblib` (опциональная зависимость MNE): без него
    # MNE молча считает в один поток и обещание «-1» ничего не значит.
    dipole_refine_n_jobs: int = Field(default=-1)
    # Оценки времени уточнения (с) — подсказка UI «сколько ждать» до запуска и
    # те же числа, что записаны в `docs/rules/dipoles.md` (замер 20.09.2026).
    dipole_refine_sec_fixed: float = Field(default=0.5)
    dipole_refine_sec_per_sample: float = Field(default=7.0)

    # Артефакты
    z_score_threshold: float = 5.0
    peak_to_peak_threshold_uv: float = 100.0
    # Порог «почти константы» (мкВ): размах (peak-to-peak) сигнала в окне
    # ``flat_line_window_ms`` ниже порога. 1 мкВ — «мёртвый» канал; обычный
    # шум (~1 мкВ std) даёт размах ~4–5 мкВ в окне 100 мс и не ловится (N7/F20).
    flat_line_threshold_uv: float = 1.0
    flat_line_min_duration_ms: float = 200.0

    # Окно «почти константы» для flat-line (N7/F20): критерий — peak-to-peak
    # в скользящем окне этой длины ниже flat_line_threshold_uv. Критерий по
    # абсолютной амплитуде (|x| < порога) ловил обычный шум: треть отсчётов
    # полосового сигнала ближе к нулю, чем 5 мкВ.
    flat_line_window_ms: float = Field(default=100.0)

    # Новые детекторы артефактов (11 видов, этап «поиск + QC»): пороги каждого
    # вида отдельно, чтобы правка одного не трогала остальные (DRY с /meta).
    # Мышечный (ЭМГ): минимальная длительность эпизода (annotate_muscle_zscore).
    muscle_min_duration_ms: float = Field(default=100.0)
    # Разрыв записи: минимальная длительность NaN/пропуска, с которого он зона.
    break_min_duration_ms: float = Field(default=500.0)
    # Сетевой шум: во сколько раз пик 50/60 Гц (+ гармоники) выше соседних частот.
    line_noise_ratio: float = Field(default=4.0)
    # Частота сети для детектора/нотча (в РФ/ЕС 50 Гц, в США 60 Гц).
    line_noise_hz: float = Field(default=50.0)
    # Клиппинг: доля отсчётов у предела АЦП в окне, с которой объявляется насыщение.
    clipping_share: float = Field(default=0.05)
    # Всплеск электрода (pop): минимальный скачок ступеньки, мкВ.
    pop_step_uv: float = Field(default=80.0)
    # Плохие каналы: z-score дисперсии канала (медиана/MAD по монтажу).
    bad_channel_z: float = Field(default=3.5)

    # QC-индикаторы каналов вьюера (шаг 0.4): доля времени канала в зонах
    # артефактов. < warn — «ок», warn..bad — «внимание», >= bad — «плохо».
    qc_channel_warn_share: float = Field(default=0.05)
    qc_channel_bad_share: float = Field(default=0.20)

    # QC-светофор записи (шаг 2.2/N10): вердикт по четырём категориям.
    # «Чистые данные», %: < bad — «плохо», < warn — «внимание».
    qc_good_data_warn_percent: float = Field(default=80.0)
    qc_good_data_bad_percent: float = Field(default=50.0)
    # Сетевой шум (пик/фон, line_noise_level): >= warn — «внимание», >= bad — «плохо».
    qc_line_noise_warn: float = Field(default=4.0)
    qc_line_noise_bad: float = Field(default=8.0)
    # SNR (медиана по каналам, channel_snr_db), дБ: < bad — «плохо», < warn — «внимание».
    qc_snr_warn_db: float = Field(default=10.0)
    qc_snr_bad_db: float = Field(default=5.0)
    # Плохие каналы (авто-список ∪ мёртвые), штук: >= warn — «внимание», >= bad — «плохо».
    qc_bad_channels_warn: int = Field(default=1)
    qc_bad_channels_bad: int = Field(default=3)

    # Нарезка эпох (без overlap) — reject-фильтр MNE отключён: отбраковка идёт
    # только по аннотациям BAD_ от наших 11 детекторов (срез артефактов).
    epoch_lengths_ms: list[float] = [250, 500, 750, 1000, 1250, 1500, 1750, 2000]
    default_epoch_length_ms: float = 2000.0

    # Частотные диапазазы
    freq_bands: dict[str, tuple] = {
        "delta": (1, 4),
        "theta": (4, 8),
        "alpha": (8, 13),
        "beta": (13, 30),
        "gamma": (30, 40),
    }
    default_single_freq_bandwidth_hz: float = 0.5  # для одиночной частоты

    # 10-20 каналы
    standard_channels: list[str] = [
        "Fp1", "Fp2", "F3", "F4", "C3", "C4",
        "P3", "P4", "O1", "O2", "F7", "F8",
        "T7", "T8", "P7", "P8", "Fz", "Cz",
        "Pz", "Oz",
    ]

    # Имена переменных окружения совпадают с именами полей в UPPER_CASE — так
    # работает pydantic-settings (``case_sensitive=False``), поэтому ``Field(env=…)``
    # здесь не пишется: это была копия имени поля и устаревший аргумент Pydantic.
    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
