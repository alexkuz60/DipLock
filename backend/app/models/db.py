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
from sqlalchemy import (
    JSON,
    Column,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
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
    """Сессия расчёта: legacy `/analyze` и write-API UI-разделов (4.4, шаг ②).

    ``kind`` различает источник строки: ``legacy`` — `/analyze`/`/jobs` (старые
    строки без ``recording_id``), ``preprocess``/``dipoles``/``dipole_refine``/
    ``spectrogram`` — задачи разделов UI, оставляющие строку при успехе (остаток
    F21). ``recording_id`` — связь с `recordings` для каскада «TTL строки =
    TTL записи» (§8.4.3); NULL у legacy-загрузок `/analyze`, у которых файла
    записи уже нет.
    """

    __tablename__ = "sessions"
    id = Column(String, primary_key=True, index=True)
    filename = Column(String)
    n_channels = Column(Integer)
    sfreq = Column(Float)
    duration_sec = Column(Float)
    epoch_length_ms = Column(Float)
    freq_band = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    # Шаг ② (4.4): происхождение и параметры прогона UI-раздела.
    recording_id = Column(
        String,
        ForeignKey(
            "recordings.recording_id",
            name="fk_sessions_recording_id",
            ondelete="CASCADE",
        ),
        nullable=True, index=True,
    )
    kind = Column(String, nullable=True, server_default="legacy")
    job_id = Column(String, nullable=True)
    params_json = Column(JSON, nullable=True)


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
    # Шаг ② (4.4): метод точки — `fast_grid` (быстрый расчёт) / `bem_fit`
    # (точный фитинг); NULL у legacy-строк `/analyze` (метод там не фиксировался).
    method = Column(String, nullable=True)


class RecordingRecord(Base):
    """Строка записи просмотра в БД (4.4, шаг ①; кирпич B1).

    Паспорт целиком живёт в сайдкаре ``recording.json`` — здесь только то, что
    должно пережить реестр в памяти и участвовать в БД-связях: ``digest``
    (дедуп), ``patient_alias`` — **анонимизированный** псевдоним вместо PHI из
    заголовка EDF (B1 «человек (псевдоним)»), и метрики для TTL. ``accessed_at``
    освежается при повторной загрузке: TTL строки = TTL записи (§8.4.3
    ``docs/data-blocks.md``), дочерние строки уходят каскадом вместе с записью.
    """

    __tablename__ = "recordings"
    __table_args__ = (
        # Дедуп по содержимому: один отпечаток — одна запись.
        Index("ix_recordings_digest", "digest", unique=True),
    )
    recording_id = Column(String, primary_key=True)
    filename = Column(String, nullable=True)
    digest = Column(String, nullable=True)
    patient_alias = Column(String, nullable=True)
    n_channels = Column(Integer, nullable=True)
    sfreq = Column(Float, nullable=True)
    duration_sec = Column(Float, nullable=True)
    created_at = Column(DateTime, nullable=True)
    accessed_at = Column(DateTime, nullable=True)


class Analysis(Base):
    """Прогон расчёта диполей = кирпич B7 (4.4, шаг ③; §8.3 ``docs/data-blocks.md``).

    Одна строка на прогон: одиночный быстрый расчёт пакета автоотчёта. Состав
    ``params_sig`` тот же, что у ``report_runs`` (вариант (а): отчёт держит FK
    ``report_runs.analyses_id`` — одна истина на прогон). Паспорт — то, что
    получено с записи (референс, каналы, sfreq) и сетка расчёта.
    """

    __tablename__ = "analyses"
    id = Column(Integer, primary_key=True)
    recording_id = Column(
        String, ForeignKey("recordings.recording_id", ondelete="CASCADE"),
        nullable=True, index=True,
    )
    kind = Column(String, nullable=True)  # fast_grid | bem_fit | refine
    params_sig = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    job_id = Column(String, nullable=True)
    reference = Column(String, nullable=True)
    channels = Column(JSON, nullable=True)
    sfreq = Column(Float, nullable=True)
    epoch_length_ms = Column(Float, nullable=True)
    grid_mm = Column(Float, nullable=True)
    n_epochs_total = Column(Integer, nullable=True)
    n_epochs_used = Column(Integer, nullable=True)
    warnings = Column(JSON, nullable=True)
    duration_sec_calc = Column(Float, nullable=True)


class AnalysisBand(Base):
    """Статус одной полосы в прогоне = B7 ``per_band_status`` (§8.3).

    ``moment_max_nam`` — база КД **внутри** полосы (концепция §3: нормировка на
    максимум своего поддиапазона); ``band_key`` — стабильная адресация полосы,
    границы — производные.
    """

    __tablename__ = "analysis_bands"
    id = Column(Integer, primary_key=True)
    analysis_id = Column(
        Integer, ForeignKey("analyses.id", ondelete="CASCADE"), index=True,
    )
    band_key = Column(String, nullable=True)
    band_hz_lo = Column(Float, nullable=True)
    band_hz_hi = Column(Float, nullable=True)
    state = Column(String, nullable=True)  # ok | empty
    n_points = Column(Integer, nullable=True)
    n_kd_passed = Column(Integer, nullable=True)
    n_errors = Column(Integer, nullable=True)
    moment_max_nam = Column(Float, nullable=True)


class DipolePoint(Base):
    """Дипольная точка поддиапазона = кирпич B6 (§8.3).

    Ключ «эпоха × поддиапазон» — UNIQUE ``(analysis_id, band_key, epoch_index)``:
    момент пика GFP — измерение пары, а не часть ключа. ``kd_basis`` несёт базис
    КД ``{moment_share_x, gof_min, moment_max_nam}`` (правило 2 §2
    ``docs/data-blocks.md``); ``kd_passed`` — вердикт или NULL, пока методика
    (C0 ``concept.md``) не задала пороги. Индекс ``(band_key, kd_passed)`` —
    вход ROI-анализа 4.5.
    """

    __tablename__ = "dipole_points"
    __table_args__ = (
        UniqueConstraint(
            "analysis_id", "band_key", "epoch_index", name="ux_dipole_points_epoch",
        ),
        Index("ix_dipole_points_band_kd", "band_key", "kd_passed"),
    )
    id = Column(Integer, primary_key=True)
    analysis_id = Column(
        Integer, ForeignKey("analyses.id", ondelete="CASCADE"), index=True,
    )
    band_key = Column(String, nullable=True)
    band_hz_lo = Column(Float, nullable=True)
    band_hz_hi = Column(Float, nullable=True)
    epoch_index = Column(Integer, nullable=True)
    peak_time_ms = Column(Float, nullable=True)
    head_coords = Column(JSON, nullable=True)
    mni_coords = Column(JSON, nullable=True)
    moment_dir = Column(JSON, nullable=True)
    amplitude_nam = Column(Float, nullable=True)
    gof = Column(Float, nullable=True)
    anatomical_structure = Column(String, nullable=True)
    brodmann_area = Column(String, nullable=True)
    method = Column(String, nullable=True)  # fast_grid | bem_fit
    kd_passed = Column(Integer, nullable=True)  # 1/0/NULL (не оценено)
    kd_basis = Column(JSON, nullable=True)
    refined = Column(JSON, nullable=True)


class ReportRun(Base):
    """Один прогон автоотчёта = кирпич B13 (§8.3; решения §8.4).

    История, не UPSERT (§8.4.2): каждая задача оставляет свою строку, «последний
    отчёт» — ``ORDER BY created_at DESC LIMIT 1``. ``warnings`` — JSON-колонка
    (§8.4.1: состав свободный, ничего из сказанного сервером не теряется), а
    числовые QC — отдельные колонки под сортировку/фильтр. ``html_path`` — путь
    к HTML **относительно** ``cache_dir`` (сам файл остаётся на диске, в БД —
    путь и ``html_version`` = ETag).
    """

    __tablename__ = "report_runs"
    __table_args__ = (
        Index("ix_report_runs_recording_created", "recording_id", "created_at"),
    )
    id = Column(Integer, primary_key=True)
    recording_id = Column(
        String, ForeignKey("recordings.recording_id", ondelete="CASCADE"),
        nullable=True, index=True,
    )
    analyses_id = Column(
        Integer, ForeignKey("analyses.id", ondelete="SET NULL"), nullable=True,
    )
    params_sig = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    job_id = Column(String, nullable=True)
    n_epochs_total = Column(Integer, nullable=True)
    n_epochs_used = Column(Integer, nullable=True)
    n_epochs_rejected = Column(Integer, nullable=True)
    qc_status = Column(String, nullable=True)
    good_data_percent = Column(Float, nullable=True)
    warnings = Column(JSON, nullable=True)
    duration_sec_calc = Column(Float, nullable=True)
    html_path = Column(String, nullable=True)
    html_version = Column(String, nullable=True)


class ReportBandSummary(Base):
    """Агрегат одной полосы пакета отчёта (B7 по полосе, §8.3).

    ``median_gof`` — **только внутри полосы** (GOF между полосами не сравним,
    принцип 3 ``docs/rules/dipoles.md``); кросс-полосной фильтр — ``median_riv``.
    """

    __tablename__ = "report_band_summaries"
    id = Column(Integer, primary_key=True)
    report_run_id = Column(
        Integer, ForeignKey("report_runs.id", ondelete="CASCADE"), index=True,
    )
    band_key = Column(String, nullable=True)
    band_hz_lo = Column(Float, nullable=True)
    band_hz_hi = Column(Float, nullable=True)
    n_epochs_used = Column(Integer, nullable=True)
    n_points = Column(Integer, nullable=True)
    n_no_attribution = Column(Integer, nullable=True)
    median_gof = Column(Float, nullable=True)
    median_riv = Column(Float, nullable=True)


class ReportNameCount(Base):
    """Счётчик «название × полоса» отчёта (§8.4.4: **все** имена, не топ-N).

    Нормализация вместо JSON нужна ради SQL «BA × полоса» (ROI-анализ 4.5);
    топ-5/12 в HTML — вопрос отображения. ``median_gof`` — внутри своей полосы.
    """

    __tablename__ = "report_name_counts"
    id = Column(Integer, primary_key=True)
    report_run_id = Column(
        Integer, ForeignKey("report_runs.id", ondelete="CASCADE"), index=True,
    )
    band_key = Column(String, nullable=True)
    kind = Column(String, nullable=True)  # structure | brodmann
    name = Column(String, nullable=True)
    count = Column(Integer, nullable=True)
    share = Column(Float, nullable=True)
    median_gof = Column(Float, nullable=True)


class ReportDynamics(Base):
    """Динамика активности структуры: 5 бинов времени (гранулярность как в HTML)."""

    __tablename__ = "report_dynamics"
    id = Column(Integer, primary_key=True)
    report_run_id = Column(
        Integer, ForeignKey("report_runs.id", ondelete="CASCADE"), index=True,
    )
    band_key = Column(String, nullable=True)
    name = Column(String, nullable=True)
    bin_index = Column(Integer, nullable=True)
    share = Column(Float, nullable=True)


class GroupAnalysis(Base):
    """Прогон группового анализа (остаток 4.7, Фаза 5): снимок определения.

    Хранит **определение** — фильтры и отпечаток — а не замороженные числа:
    агрегат пересчитывается по живой БД при чтении (решение-точка 1 плана:
    честность по текущим данным; строки-участники живут отдельно и убывают
    каскадно вместе с записями, §8.4.3). История прогонов — не UPSERT
    (§8.4.2): каждая кнопка «Сохранить прогон» оставляет свою строку.
    """

    __tablename__ = "group_analyses"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=True)  # подпись пользователя; NULL — без имени
    band_key = Column(String, nullable=True)
    filters = Column(JSON, nullable=True)  # GroupAggregateIn без recording_ids
    params_sig = Column(String, nullable=True)  # отпечаток фильтров (ключ истории)
    created_at = Column(DateTime, default=datetime.utcnow)
    n_sessions_requested = Column(Integer, nullable=True)  # размер группы при создании


class GroupAnalysisMember(Base):
    """Участник группы: запись в составе прогона (many-to-many + порядок выбора).

    ``recording_id`` — без FK: SQLite не проверяет внешние ключи по умолчанию,
    а членство обязано убывать вместе с записью — это делает явным
    ``recording_store._delete_recording_rows`` (тот же приём, что и для
    строк ``sessions``/``analyses``, §8.4.3).
    """

    __tablename__ = "group_analysis_members"
    __table_args__ = (
        Index("ux_group_members_pair", "group_analysis_id", "recording_id", unique=True),
    )
    id = Column(Integer, primary_key=True)
    group_analysis_id = Column(
        Integer, ForeignKey("group_analyses.id", ondelete="CASCADE"), index=True,
    )
    recording_id = Column(String, nullable=True, index=True)
    position = Column(Integer, nullable=True)  # порядок выбора в UI — колонки карты


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

